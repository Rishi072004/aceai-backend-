import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import User from '../models/User.js';
import Resume from '../models/Resume.js';
import Chat from '../models/Chat.js';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { llmClient, llmProviderName } from '../services/llmProvider.js';
import { createClient as createDeepgramClient } from '@deepgram/sdk';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Deepgram client for STT/TTS
const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
const deepgram = deepgramApiKey ? createDeepgramClient(deepgramApiKey) : null;

// Utility helpers
const pickRandom = (arr = []) => arr[Math.floor(Math.random() * arr.length)] || '';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clampWords = (text, maxWords = 200) => {
  if (!text) return '';
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(' ').trim();
};
const enforceQuestionOnly = (text, maxWords = 60) => {
  if (!text) return '';
  // Try to grab the first question-like sentence
  const questionMatch = text.match(/[^?]*\?/);
  const candidate = questionMatch ? questionMatch[0] : text.split(/\.|!/)[0] || text;
  const trimmed = clampWords(candidate, maxWords);
  return trimmed.endsWith('?') ? trimmed : `${trimmed}?`;
};

const extractBatchQuestions = (rawText, desiredCount = 3) => {
  if (!rawText) return [];
  const parts = rawText
    .split('|||')
    .map((p) => p.trim())
    .filter(Boolean);

  let candidates = parts.length ? parts : [];
  if (!candidates.length) {
    const matched = rawText.match(/[^?]*\?/g) || [];
    candidates = matched.map((m) => m.trim()).filter(Boolean);
  }

  const cleaned = candidates
    .map((q) => enforceQuestionOnly(clampWords(q, 200), 60))
    .map((q) => (q ? q.trim() : ''))
    .filter((q) => q.endsWith('?'));

  const unique = Array.from(new Set(cleaned));
  return unique.slice(0, Math.max(1, desiredCount));
};
// Detect mentions of named entities that aren't present in provided context
const detectHallucinatedEntities = (text, allowedContext) => {
  if (!text || !allowedContext) return false;
  const ctx = allowedContext.toLowerCase();
  const matches = [];

  // Match multi-word Title Case sequences and longer acronyms to reduce false positives
  const titleCaseRegex = /\b([A-Z][a-z0-9]{2,}\s+[A-Z][a-z0-9]{2,}(?:\s+[A-Z][a-z0-9]{2,}){0,2})\b/g;
  const acronymRegex = /\b([A-Z]{4,})\b/g;

  let m;
  while ((m = titleCaseRegex.exec(text))) {
    matches.push(m[1]);
  }
  while ((m = acronymRegex.exec(text))) {
    matches.push(m[1]);
  }

  // Filter matches that appear in the allowed context
  const unknowns = matches.filter((tok) => {
    if (!tok) return false;
    const low = tok.toLowerCase();
    return !ctx.includes(low);
  });

  return unknowns.length > 0 ? unknowns : false;
};

// Extract a short list of required skills from the job prompt
const extractRequiredSkills = (jobPrompt) => {
  if (!jobPrompt) return [];
  const lines = jobPrompt.split('\n');
  const line = lines.find(l => l.toLowerCase().startsWith('required skills:')) || '';
  const raw = line.split(':').slice(1).join(':').trim();
  if (!raw || /not specified/i.test(raw)) return [];
  const skills = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (skills.length > 0) return skills.slice(0, 5);

  // Fallback: extract common tech terms from job description text
  const jobText = jobPrompt.toLowerCase();
  const commonSkills = [
    'html', 'css', 'javascript', 'typescript', 'react', 'vue', 'angular', 'node', 'express',
    'mongodb', 'mysql', 'postgres', 'sql', 'rest', 'api', 'git', 'docker', 'aws', 'azure'
  ];
  const found = commonSkills.filter(skill => jobText.includes(skill));
  return found.slice(0, 5).map(s => s.toUpperCase() === s ? s : s[0].toUpperCase() + s.slice(1));
};
// Sanitize resume and LLM text: strip markdown, headings, numbering, and short title-like lines
const sanitizeText = (text) => {
  if (!text) return '';
  let t = String(text);
  // Remove common markdown and formatting
  t = t.replace(/\*\*|__|\*|`|~~|\[|\]|\(|\)/g, '');
  t = t.replace(/<[^>]*>/g, '');
  // Remove markdown headings and blockquote markers
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^>\s?/gm, '');
  // Remove leading numbering like '1. ', '1) ', '1 - ' and trailing isolated numeric markers like ' 1?'
  t = t.replace(/^\s*\d+[\.|\)|\-]\s+/gm, '');
  t = t.replace(/\s+\d+\?\s*$/gm, '');
  t = t.replace(/\s+\d+\s*$/gm, '');
  // Remove lines that are extremely short and look like titles (<=2 words and non-descriptive)
  t = t.split('\n').filter(l => {
    const s = l.trim();
    if (!s) return false;
    const words = s.split(/\s+/);
    if (words.length <= 2 && s.length < 25 && /[^a-zA-Z0-9]/.test(s)) return false;
    // Remove lines that are just 'Answer' or 'Summary' etc.
    if (/^answer[:\-–—]?$/i.test(s) || /^summary[:\-–—]?$/i.test(s)) return false;
    return true;
  }).join('\n');
  // Collapse multiple whitespace
  t = t.replace(/\s{2,}/g, ' ').trim();
  return t;
};

// Normalize text for simple similarity checks
const normalizeForCompare = (s) => {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
};

// Build a short structured resume summary (top projects, top skills, years, primary role)
const createResumeSummary = (structured, rawText) => {
  if (!structured && !rawText) return '';
  const parts = [];
  if (structured) {
    if (structured.primaryRole) parts.push(`Primary role: ${structured.primaryRole}`);
    if (structured.yearsOfExperience) parts.push(`Years experience: ${structured.yearsOfExperience}`);
    if (Array.isArray(structured.technicalSkills) && structured.technicalSkills.length > 0) {
      parts.push(`Top skills: ${structured.technicalSkills.slice(0,3).join(', ')}`);
    }
    if (Array.isArray(structured.projects) && structured.projects.length > 0) {
      const projSummaries = structured.projects.slice(0,3).map(p => {
        const tech = p.technologies && p.technologies.length ? ` (${p.technologies.join(', ')})` : '';
        return `${p.name}${tech}`;
      });
      parts.push(`Projects: ${projSummaries.join('; ')}`);
    }
    if (Array.isArray(structured.structuredExperience) && structured.structuredExperience.length > 0) {
      const exp = structured.structuredExperience[0];
      parts.push(`Recent: ${exp.jobTitle || ''} at ${exp.company || ''}${exp.duration ? ` (${exp.duration})` : ''}`);
    }
  }
  // If still empty, fall back to a short raw text excerpt
  if (parts.length === 0 && rawText) {
    const excerpt = rawText.replace(/\s+/g, ' ').trim().slice(0, 400);
    parts.push(`Resume excerpt: ${excerpt}${rawText.length > 400 ? '...' : ''}`);
  }
  return parts.join('\n');
};

// Simple word-overlap similarity (set intersection over union)
const overlapSimilarity = (a, b) => {
  if (!a || !b) return 0;
  const wa = new Set(a.split(/\s+/).filter(Boolean));
  const wb = new Set(b.split(/\s+/).filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let intersect = 0;
  wa.forEach(w => { if (wb.has(w)) intersect++; });
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : intersect / union;
};

// Validate that a text is a proper interrogative question
const isValidQuestion = (text) => {
  if (!text) return false;
  const s = String(text).trim();
  if (!s.endsWith('?')) return false;
  // Reject trivial numeric questions like '1?'
  if (/^\s*\d+\?\s*$/.test(s)) return false;
  // Require at least 3 words
  const wordCount = s.split(/\s+/).filter(Boolean).length;
  if (wordCount < 3) return false;
  // Must start with an interrogative or modal/helper that makes it a question
  const interrogatives = /^(who|what|when|where|why|how|describe|explain|can|could|do|did|are|is|would|should|tell|walk|compare|which|whom)\b/i;
  if (interrogatives.test(s)) return true;
  // Also allow polite requests like "Could you...", "Would you..."
  if (/^(could|would|please)\b/i.test(s)) return true;
  return false;
};

// Detect answer-like responses that should trigger regeneration
const isAnswerLike = (text) => {
  if (!text) return false;
  const s = String(text).trim().toLowerCase();
  return s.startsWith("i ") || s.startsWith("i'm ") || s.startsWith("i’ve ") || s.startsWith("i've ") ||
    s.startsWith("we ") || s.startsWith("we've ") || s.startsWith("we’ve ") ||
    s.startsWith("during ") || s.startsWith("in my ") || s.startsWith("my ") ||
    s.startsWith("absolutely") || s.startsWith("sure") || s.startsWith("yes,");
};

// Log LLM payloads for debugging (only logs messages, no keys)
const logLLMPayload = (label, messages) => {
  try {
    if (!messages) return;
    console.log(`LLM Payload - ${label}:`);
    messages.forEach((m, idx) => {
      const preview = (m.content || '').replace(/\n/g, ' ').slice(0, 800);
      console.log(`  [${idx}] ${m.role}: ${preview}${(m.content || '').length > 800 ? '...(truncated)' : ''}`);
    });
  } catch (e) {
    console.warn('Failed to log LLM payload:', e?.message || e);
  }
};
const QUESTION_RULES = `
INTERVIEW QUESTION RULES:
1) Stay strictly within the selected job field and role; avoid generic/unrelated topics.
2) Align with the job profile; include situational, role-based, and real-world scenarios.
3) Test core skills: foundations, practical use, best practices, and common pitfalls.
4) Use progressive depth: basics → intermediate → deep follow-ups; probe claimed proficiency.
5) Prefer practical/scenario questions with trade-offs and reasoning.
6) If resume is provided: anchor to explicit projects, tools, technologies, and experience; validate claims.
7) Adapt difficulty based on performance; do not overwhelm early; build confidence, then deepen.
8) Balance coverage: technical knowledge, role responsibilities, problem solving; avoid redundancy.
9) Keep tone professional, clear, concise; one question at a time; no fluff.
10) Do not repeat questions; no multi-question bundles unless deepening the same topic.
11) QUESTION ORDER: start with technical questions tied to the job description skills; then ask experience-based questions; then project-specific questions; finish with behavioral questions.`;

// Role & Experience Lock - global guardrails appended to all system prompts
const ROLE_EXPERIENCE_LOCK = `
\nROLE & EXPERIENCE LOCK (MUST ENFORCE INTERNALLY):
- Before generating any question, LOCK onto the provided *job role* and the candidate's *experience level* (years) as stated in the prompt/context.
- Do NOT reinterpret, broaden, or generalize the role beyond the exact job title or description provided.
- Enforce hard experience-level constraints when choosing question depth:
  - Experience 0-1 years: Ask ONLY fundamentals, conceptual basics, and simple practical checks. No deep design or advanced practical scenarios.
  - Experience 1-3 years: Ask practical, moderately deep technical questions and small-system reasoning; avoid large-scale architecture or multi-team ownership scenarios.
  - Experience 3+ years: You may ask deeper reasoning, trade-offs, and scenario-based questions appropriate for senior-level contributors.
- SELF-CHECK RULE: For every generated question, internally verify that it complies with the role and experience constraints above. If a generated question violates these constraints, DISCARD it and regenerate until it complies. Do not output any discarded drafts.`;

// Starter plan negative rules (only to be appended when the caller indicates Starter/Free plan)
const STARTER_NEGATIVE_RULES = `
\n📌 STARTER-PLAN LIMITATIONS (ENFORCE STRICTLY):
- DO NOT ask resume-based questions (even if resume content is present).
- DO NOT assume or ask about past company-specific experience.
- DO NOT ask system-design or architecture questions.
- DO NOT ask leadership, ownership, or management-level questions.
- Starter questions MUST rely strictly on job title, job description, and role fundamentals.`;

// Anti-hallucination mandatory guardrail
const ANTI_HALLUCINATION_RULE = `
\nANTI-HALLUCINATION RULE (MANDATORY):
- Do NOT invent, assume, or fabricate specific projects, company names, or systems.
- NEVER reference a project, pipeline, or implementation unless it is EXPLICITLY mentioned in the resume or provided context.
- If a project is not explicitly listed, ask a GENERAL role-appropriate question instead.
- Do NOT ask presentation-style questions such as "step-by-step walkthrough" unless the candidate explicitly described building that system.`;

// Starter pack additional safety rule
const STARTER_PACK_SAFETY_RULE = `
\nSTARTER PACK SAFETY RULE:
- Do NOT ask questions that assume ownership of complex systems (streaming pipelines, distributed systems, real-time audio, architecture).
- Use only fundamentals, role-level concepts, and simple project discussions.
- If unsure whether a topic is too advanced, default to a simpler question.`;

// Starter pack Strict mode enhancement (ONLY for Strict mode in Starter plan)
const STARTER_PACK_STRICT_RULE = `
\n🔥 STARTER PACK STRICT MODE - MAXIMUM RIGOR (ZERO TOLERANCE):
- Ask ONLY about core technologies and skills mentioned in job description - NOTHING ELSE.
- Expect candidates to demonstrate EXPERT-LEVEL MASTERY of every required skill.
- Ask brutal questions about edge cases, performance implications, failure modes, and trade-off decisions.
- Test problem-solving and debugging approaches specific to the role at production scale.
- DO NOT ask easy/implementation questions - ask ARCHITECTURAL and DESIGN questions.
- Questions should reveal if candidate can truly handle the role's HARDEST problems.
- Demand they explain WHY choices matter, not just WHAT they know.
- Test their deepest production experience - failures, scaling issues, optimizations.
- Zero tolerance for surface-level knowledge - always probe one level deeper.
- Ask about security implications, attack vectors, defensive patterns for the role.
- If answer seems complete, ask "What if [hard constraint]?" to find limits of knowledge.
- Test if they can reason through UNFAMILIAR HARD PROBLEMS using their mastery of fundamentals.`;

// Hard enforcement: always output exactly one concise question and nothing else
const HARD_QUESTION_ONLY = `
\n!!! HARD ENFORCEMENT - QUESTION ONLY !!!
- Output EXACTLY ONE concise interview QUESTION and NOTHING ELSE.
- Do NOT include acknowledgements, confirmations, explanations, answers, or prefatory text.
- Do NOT output lists, examples, or multiple sentences that are not the single question.
- If you cannot formulate a question based on provided context, output a short clarifying question about available details.
`;

// Prioritize the TARGET JOB when generating questions (should take precedence over resume)
const PRIORITIZE_TARGET_JOB = `
\nPRIORITIZE TARGET JOB:
- Always prioritize the TARGET JOB's requirements, role, and job description when crafting questions.
- Use the resume only to SUPPORT relevance to the TARGET JOB (examples, projects, skills that map to job requirements).
- If the resume conflicts with the job requirements, ask clarifying questions about fit for the TARGET JOB rather than assuming equivalence.
`;

// After a sustained run of questions, prioritize core skills then HR checks
const CORE_SKILLS_THEN_HR = `
\nAFTER 10 QUESTIONS - FOCUS SHIFT:
- Now prioritize asking about the CORE SKILLS explicitly required by the TARGET JOB (technical depth, practical application, common pitfalls, trade-offs).
- Ask 2-4 targeted deep questions mapped to the job's required skills; each should be specific, scenario-based, and probe demonstrated competence.
- After core-skill probes, ask 1-2 concise HR/behavioral questions about teamwork, culture-fit, and communication (keep these short).
- Do NOT return to broad or unrelated topics; keep questions directly tied to job requirements and demonstrated resume experience.`;

// Helper function to generate company-specific questions (Groq via OpenAI-compatible client)
const generateCompanyQuestions = async (company, mode = 'moderate', jobRole = '') => {
  if (!company) return null;
  
  try {
    console.log(`🏢 Generating AI questions for: ${company} (Mode: ${mode})`);
    
    // Determine question type based on mode
    let questionTypePrompt = '';
    if (mode === 'strict' || mode === 'technical') {
      questionTypePrompt = 'Generate 3 tough technical/system design questions that this company typically asks. Focus on data structures, algorithms, and system design. Keep each between 50-70 words.';
    } else if (mode === 'friendly') {
      questionTypePrompt = 'Generate 3 behavioral questions that this company typically asks. Focus on soft skills, teamwork, and personal growth. Keep each between 50-70 words.';
    } else {
      // moderate - mix of all
      questionTypePrompt = 'Generate 3 questions that this company typically asks - mix of 1 technical question, 1 system design question, and 1 behavioral question. Keep each between 50-70 words.';
    }
    
    const prompt = `You are an expert at interview question generation for major tech companies.

Company: ${company}${jobRole ? `\nRole: ${jobRole}` : ''}

${questionTypePrompt}

Requirements:
1. Generate REALISTIC questions that this company actually asks in interviews
2. Make questions specific to ${company}'s products, services, or engineering challenges
3. Questions should match the company's interview style and difficulty level
4. Return ONLY the questions, one per line, numbered 1-3
5. Make them challenging and thoughtful, not generic
6. Keep each question between 50-70 words, single sentence

Generate the questions now:`;

    logLLMRequest('company questions');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an expert technical interviewer who knows exactly what questions major tech companies ask. Generate realistic, company-specific interview questions.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 120,
      temperature: 0.7,
    });

    const questionsText = response.choices[0].message.content;
    console.log(`✅ Generated questions for ${company}:\n${questionsText}`);
    
    // Parse the numbered questions
    const questionLines = questionsText
      .split('\n')
      .filter(line => line.trim().match(/^\d+\./))
      .map(line => line.replace(/^\d+\.\s*/, '').trim())
      .filter(q => q.length > 0);

    return {
      company: company,
      questions: questionLines.length > 0 ? questionLines : [questionsText],
      hasRealQuestions: true,
      isAIGenerated: true
    };
  } catch (error) {
    console.error(`❌ Error generating questions for ${company}:`, error.message);
    return null;
  }
};

// Helper function to get company-specific questions (now AI-powered)
const getCompanyQuestions = async (company, mode = 'moderate', jobRole = '') => {
  return await generateCompanyQuestions(company, mode, jobRole);
};

const starterGreetings = [
  ({ jobTitle, company }) => `Hi there! Let's have a quick chat${jobTitle ? ` about the ${jobTitle}` : ''}${company ? ` at ${company}` : ''}.`,
  ({ jobTitle, company }) => `Welcome! Excited to learn more${jobTitle ? ` about your fit for ${jobTitle}` : ''}${company ? ` at ${company}` : ''}.`,
  ({ jobTitle, company }) => `Great to meet you. We'll keep this relaxed${jobTitle ? ` and focused on ${jobTitle}` : ''}${company ? ` at ${company}` : ''}.`,
  ({ jobTitle, company }) => `Thanks for joining. Let's ease in${jobTitle ? ` with the ${jobTitle}` : ''}${company ? ` at ${company}` : ''}.`
];

const shortFeedbackOptions = {
  friendly: ['Nice!', 'Good one.', 'Sounds great!', 'Love that.', 'Excellent.', 'Awesome.'],
  moderate: ['Good.', 'Got it.', 'Thanks.', 'Makes sense.', 'Understood.', 'Nice.'],
  strict: ['Noted.', 'Understood.', 'Okay.', 'Alright.', 'Got it.'],
  default: ['Good.', 'Nice.', 'Great.', 'Alright.', 'Thanks.']
};

const buildStarterGreeting = ({ jobTitle, company, mode }) => {
  return pickRandom(starterGreetings)({ jobTitle, company, mode }) || "Hi there! Let's get started.";
};

const getShortFeedback = (mode = 'moderate') => {
  const list = shortFeedbackOptions[mode] || shortFeedbackOptions.default;
  return pickRandom(list) || 'Good.';
};

// Helper to create a File-like object from buffer for OpenAI SDK v6+
const createBlobFromBuffer = (buffer, filename, mimeType) => {
  const readable = new Readable();
  readable.push(buffer);
  readable.push(null);
  readable.name = filename;
  readable.type = mimeType;
  readable[Symbol.toStringTag] = 'File';
  return readable;
};

// LLM client (OpenAI by default, Groq when AI_PROVIDER=groq)
const openai = llmClient;

const LLM_LOG_ENABLED = process.env.LLM_LOG_ENABLED === 'true';

const logLLMRequest = (context = '') => {
  if (!LLM_LOG_ENABLED) return;
  const suffix = context ? ` - ${context}` : '';
  console.log(`Using LLM Provider: ${llmProviderName}${suffix}`);
};

// Setup multer for audio file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { 
    fileSize: 25 * 1024 * 1024, // 25MB max file size
    files: 1
  },
  fileFilter: (req, file, cb) => {
    console.log('📎 Multer receiving file:', {
      fieldname: file.fieldname,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size
    });
    // Accept audio files
    if (file.mimetype.startsWith('audio/') || file.fieldname === 'audio') {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed. Only audio files accepted.`));
    }
  }
});

// @desc    Test endpoint to check if AI routes are working
// @route   GET /api/ai/test
// @access  Public
router.get('/test', (req, res) => {
  console.log('=== AI TEST ENDPOINT ===');
  const apiKey = process.env.OPENAI_API_KEY;
  res.status(200).json({
    status: 'success',
    message: 'AI routes are working!',
    apiProvider: 'OpenAI',
    apiKeyConfigured: !!apiKey,
    apiKeyLength: apiKey ? apiKey.length : 0,
    timestamp: new Date().toISOString()
  });
});

// @desc    Get AI interview response (Text-based)
// @route   POST /api/ai/interview
// @access  Private
router.post('/interview', authenticateToken, asyncHandler(async (req, res) => {
  const { userAnswer, interviewMode, targetJobId, resumeId, conversation } = req.body;
  const requestedBatchCount = Math.max(1, Math.min(Number(req.body.batchCount) || 1, 3));
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔍 [BATCH DEBUG] Batch Request Received');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 Request Details:', {
    endpoint: 'POST /api/ai/interview',
    rawBatchCount: req.body.batchCount,
    clampedBatchCount: requestedBatchCount,
    isBatchRequest: requestedBatchCount > 1,
    userId: req.user._id,
    userPlan: req.user?.plan,
    mode: interviewMode
  });
  
  if (!deepgram) {
    return res.status(501).json({
      status: 'error',
      message: 'TTS currently unavailable on this server. Set DEEPGRAM_API_KEY to enable server TTS.'
    });
  }

  try {
    console.log('\n=== POST /api/ai/interview ===');
    console.log('Resume ID provided:', resumeId ? 'Yes' : 'No');
    console.log('User ID:', req.user._id);
    
    // Get mode configuration (fallback to 'moderate')
    const modeConfig = getModeConfig(interviewMode || 'moderate');
    
    // Check if Starter/Free (job-focused only)
    const isStarterOrFree = req.user?.plan === 'STARTER' || req.user?.plan === 'FREE';
    
    // Store clean job info for fallback questions (without emojis)
    let cleanJobTitle = req.body.jobTitle || '';
    let cleanCompany = req.body.company || '';
    
    // Load resume context if provided - ENHANCED: Use structured extracted data
    let resumePrompt = '';
    let fullResumeText = '';
    let structuredResumeData = null;
    
    // DISABLED FOR TESTING: Skip resume loading for Starter pack
    if (isStarterOrFree) {
      console.log('📋 STARTER/FREE PACK: Skipping resume context, job-focused only');
    } else {
      try {
        if (resumeId) {
          console.log('🔍 Looking for resume with ID:', resumeId);
          console.log('   ID Type:', typeof resumeId);
          console.log('   User ID:', req.user._id);
          
          const resume = await Resume.findOne({ _id: resumeId, userId: req.user._id });
          
          if (resume) {
            console.log('✅ Resume found!');
            console.log('   - Raw text length:', resume.rawText?.length || 0);
            console.log('   - File name:', resume.fileName);
            
            // CRITICAL: Extract FULL resume text content
            fullResumeText = resume.rawText || resume.parsedData?.summary || '';
            
            // Get the structured extracted data (projects, experience, education, skills)
            const analysis = resume.analysis || {};
            structuredResumeData = {
              primaryRole: analysis.primaryRole || 'Not specified',
              yearsOfExperience: analysis.yearsOfExperience || 0,
              technicalSkills: analysis.technicalSkills || [],
              softSkills: analysis.softSkills || [],
              structuredExperience: analysis.structuredExperience || [],
              projects: analysis.projects || [],
              education: analysis.education || [],
              achievements: analysis.achievements || []
            };
            
            console.log('📊 Structured Resume Data:');
            console.log('   - Primary Role:', structuredResumeData.primaryRole);
            console.log('   - Years:', structuredResumeData.yearsOfExperience);
            console.log('   - Technical Skills:', structuredResumeData.technicalSkills.length);
            console.log('   - Projects:', structuredResumeData.projects.length);
            console.log('   - Work Experience:', structuredResumeData.structuredExperience.length);
            console.log('   - Education:', structuredResumeData.education.length);
            
            // Use concise structured resume summary instead of full raw text for prompts
            try {
              resumePrompt = createResumeSummary(structuredResumeData, fullResumeText);
            } catch (e) {
              console.warn('Could not create concise resume summary:', e?.message || e);
              resumePrompt = '';
            }
          } else {
            console.warn('❌ Resume NOT found in database for ID:', resumeId);
            console.warn('   User ID:', req.user._id);
            return res.status(400).json({
              status: 'error',
              message: 'Selected resume not found. Please re-upload or re-select your resume.'
            });
          }
        } else {
          console.log('⚠️  No resume ID provided in request');
        }
      } catch (e) {
        console.warn('Resume context load failed:', e.message);
        console.warn('Error details:', e.stack);
      }
    }
    
    // FALLBACK: If no structured data but we have raw text, use a short excerpt (only if not Starter)
    if (!isStarterOrFree && !resumePrompt && fullResumeText) {
      console.log('⚠️  Fallback: Using short resume excerpt (structured data not available)');
      const excerpt = sanitizeText(fullResumeText).replace(/\s+/g, ' ').slice(0, 400);
      resumePrompt = `Resume excerpt: ${excerpt}${fullResumeText.length > 400 ? '...' : ''}`;
    }
    
    // Load job context if provided - ENHANCED: Send full job description
    let jobPrompt = '';
    let fullJobDescription = '';
    let companyQuestionContext = '';
    try {
      if (targetJobId) {
        const userDoc = await User.findById(req.user._id).select('targetJobs');
        const job = userDoc?.targetJobs.id(targetJobId);
        if (job) {
          const skillsText = Array.isArray(job.skills) ? job.skills.join(', ') : '';
          fullJobDescription = job.description || `${job.role} at ${job.company || 'Target Company'}`;
          // Clamp long job descriptions to a concise summary
          if (fullJobDescription && fullJobDescription.length > 600) {
            fullJobDescription = fullJobDescription.slice(0, 600) + '...';
          }
          
          jobPrompt = `\n\n TARGET JOB DETAILS (for matching with resume):
═════════════════════════════════════
Role: ${job.role || 'Not specified'}
Company: ${job.company || 'Not specified'}
Location: ${job.location || 'Not specified'}
Required Skills: ${skillsText || 'Not specified'}

Job Description:
${fullJobDescription}
═════════════════════════════════════

⚠️  CRITICAL CLARIFICATION:
This is the TARGET JOB they are APPLYING FOR. They do NOT currently work there.
They are interviewing FOR this position.

INSTRUCTIONS FOR ASKING ABOUT JOB REQUIREMENTS:
1. ASK ABOUT THEIR PAST EXPERIENCE - NOT experience at this target company
2. How does their past experience prepare them for this role?
3. Ask about their experience with the specific SKILLS/TECHNOLOGIES required for this job
4. Ask how they would approach the RESPONSIBILITIES mentioned in the job description
5. Reference specific requirements and ask how their resume shows they can handle them
6. NEVER ask "Tell me about your experience at [this company]" - they don't work there yet
7. Instead ask: "This role requires [requirement] - tell me about your experience with [relevant skill/project from resume]"
8. Ask how they would apply their past experience to this new role
9. Ask about their interest in this specific role and company
10. Assess if their background is a good fit for what this job requires`;
          
          // Check for company-specific questions (skip for Starter/Free)
          if (!isStarterOrFree && job.company) {
            const companyQuestions = await getCompanyQuestions(job.company, interviewMode, job.role);
            if (companyQuestions) {
              companyQuestionContext = `\n\nCOMPANY CONTEXT (for tailoring questions):
Company: ${companyQuestions.company}
AI-Generated typical interview questions they ask:
${companyQuestions.questions.slice(0, 3).map((q, i) => `${i+1}. ${q}`).join('\n')}

NOTE: These are questions generated by AI based on how ${companyQuestions.company} typically interviews.
Reference them when relevant but always relate to the candidate's PAST EXPERIENCE, not this company's experience.`;
            }
          }
        }
      }
      // If no targetJobId but frontend provided jobTitle/jobDescription in body, use them
      else if ((req.body.jobTitle || req.body.jobDescription)) {
        const jbTitle = req.body.jobTitle || '';
        const jbDesc = req.body.jobDescription || '';
        const skillsText = Array.isArray(req.body.skills) ? req.body.skills.join(', ') : (req.body.skills || 'Not specified');
        fullJobDescription = jbDesc || jbTitle;
        if (fullJobDescription && fullJobDescription.length > 600) fullJobDescription = fullJobDescription.slice(0,600) + '...';
        jobPrompt = `\n\nTARGET POSITION:\nRole: ${jbTitle || 'Not specified'}${req.body.company ? `\nCompany: ${req.body.company}` : ''}\n\nJob Description:\n${fullJobDescription}\n\nRequired Skills: ${skillsText}`;
        cleanJobTitle = jbTitle;
        cleanCompany = req.body.company || '';
      }
    } catch (e) {
      console.warn('Job context load failed:', e.message);
    }

    const jobSkills = extractRequiredSkills(jobPrompt);
    const jobSkillsText = jobSkills.length ? jobSkills.join(', ') : '';

    // Build conversation context from recent history for continuity (limit to last N turns)
    let conversationContext = '';
    let interviewProgressNote = '';
    if (conversation && Array.isArray(conversation) && conversation.length > 0) {
      const lastN = 6;
      const recent = conversation.slice(-lastN);
      const conversationHistory = recent
        .map((msg) => {
          const role = msg.type === 'user' ? 'Candidate' : 'Interviewer';
          return `${role}: ${msg.text}`;
        })
        .join('\n\n');
      
      // Track interview progress with structured flow
      const questionsAsked = conversation.filter(msg => msg.type !== 'user').length;
      let interviewPhase = 'initial';
      let phaseGuidance = '';
      const isStarterOrFree = req.user?.plan === 'STARTER' || req.user?.plan === 'FREE';
      
      if (questionsAsked < 2) {
        interviewPhase = 'technical-skills';
        phaseGuidance = '\n\n📋 PHASE 1 - CORE TECHNICAL SKILLS (Questions 1-5):\nAsk about the SPECIFIC technologies, tools, and skills mentioned in the job requirements.\nExample areas: programming languages, frameworks, databases, tools they must know.\nStay warm and encouraging - make it feel like a conversation, not an interrogation.';
      } else if (questionsAsked < 5) {
        interviewPhase = 'experience-projects';
        phaseGuidance = '\n\nPHASE 2 - EXPERIENCE & PROJECTS (Questions 6-12):\nAsk about their REAL PROJECT EXPERIENCE with the technologies from Phase 1.\nIf they don\'t have direct experience, ask about relevant projects they\'ve built.\nFocus on: What they built, their role, technical decisions, challenges overcome.\nBe curious and supportive - this shows genuine interest in their background.';
      } else {
        interviewPhase = 'behavioral';
        phaseGuidance = '\n\n🎯 PHASE 3 - BEHAVIORAL & ROLE FIT (Questions 13-20):\nAsk about HOW they work: problem-solving, learning, collaboration, handling challenges.\nTie back to the job requirements: discuss how their approach fits the role.\nRemain warm and encouraging - let them show their personality and values.';
      }
      
      conversationContext = `\n\nINTERVIEW HISTORY:\n${conversationHistory}${phaseGuidance}\n\nBased on this conversation, ask the next relevant follow-up that:\n1. Matches the CURRENT PHASE (${interviewPhase})\n2. References something they mentioned (shows you're listening)\n3. Digs deeper into their experience or reasoning\n4. Remains warm and genuinely interested`;
    }

    logLLMRequest('initial interview question');
    
    // CRITICAL VALIDATION: Require job OR resume per user plan
    // isStarterOrFree already declared above
    if (isStarterOrFree && !jobPrompt) {
      console.warn('⚠️  STARTER PACK ERROR: No job selected. Starter pack requires a target job.');
      return res.status(400).json({
        status: 'error',
        message: 'Please select a Target Job to begin the interview. Starter pack interviews are job-focused only.'
      });
    }
    
    if (!isStarterOrFree && !jobPrompt && !resumePrompt) {
      console.warn('⚠️  VALIDATION ERROR: Neither job nor resume provided.');
      return res.status(400).json({
        status: 'error',
        message: 'Please provide either a Target Job or upload your Resume to start the interview.'
      });
    }
    
    // For Starter pack, REMOVE resume context entirely - job only
    if (isStarterOrFree) {
      console.log('📋 STARTER PACK: Removing resume context, job-focused only');
      resumePrompt = '';
      fullResumeText = '';
    }
    
    // If both a target job and a resume are present, instruct resume to defer to the target job
    if (jobPrompt && resumePrompt) {
      resumePrompt = `\n\nNOTE: When a TARGET JOB is present, PRIORITIZE the TARGET JOB requirements and craft questions focused on the job. Use the resume only to SUPPORT job-focused questions (examples/projects/skills that map to the job).\n` + resumePrompt;
    }

    // Sanitize resume and job text to remove headings/markdown that the model might echo
    resumePrompt = sanitizeText(resumePrompt);
    fullResumeText = sanitizeText(fullResumeText);

    // BUILD FINAL SYSTEM PROMPT
    const starterNote = isStarterOrFree ? (STARTER_NEGATIVE_RULES + STARTER_PACK_SAFETY_RULE) : '';
    
    // Check if this is the FIRST question (empty conversation)
    const isFirstQuestion = !conversation || conversation.length === 0;
    
    // For first question, ask them to introduce themselves
    if (isFirstQuestion) {
      console.log('🎯 FIRST QUESTION: Starting interview with Introduction');
      // Return introduction question immediately without complex LLM calling
      const jobRole = fullJobDescription && fullJobDescription.trim() 
        ? jobPrompt.split('\n').find(line => line.includes('Role:'))?.split(':')[1]?.trim() || 'this role'
        : 'this role';
      
      let introQuestion = '';
      if (interviewMode === 'friendly') {
        // Friendly mode: warm and encouraging introduction question
        introQuestion = req.body.company 
          ? `Hey! Thanks for joining - we're excited to meet you! Let's start simple. Tell me a bit about yourself and your background, especially anything relevant to ${req.body.company}. No need to be formal - just be yourself! 😊`
          : `Hey! Thanks for joining - we're excited to meet you! Could you tell me a bit about yourself and your professional background? Feel free to focus on any experience related to ${jobRole}. No need to be formal!`;
      } else {
        // Other modes: standard introduction
        introQuestion = req.body.company 
          ? `Thanks for joining! Let's start with the basics. Could you briefly introduce yourself and tell me about your professional background, especially any experience relevant to ${req.body.company}?`
          : `Thanks for joining! Let's start with the basics. Could you briefly introduce yourself and tell me about your professional background, especially as it relates to ${jobRole}?`;
      }
      
      return res.status(200).json({
        status: 'success',
        data: {
          response: introQuestion
        }
      });
    }

    // =========================================================================
    // HANDLE CLARIFICATION REQUESTS (repeat, elaborate, clarify, etc.)
    // =========================================================================
    const userAnswerLower = (userAnswer || '').toLowerCase().trim();
    
    // Detect "skip/move on" patterns - user wants to move to next question
    const skipPatterns = [
      /^(let'?s?\s+)?move\s+on/i,
      /^next\s+(question|one)/i,
      /^skip\s+(this|it|that)/i,
      /^(can\s+we\s+)?go\s+to\s+(the\s+)?next/i,
      /^(let'?s?\s+)?proceed/i,
      /^(i'?d?\s+)?(like\s+to\s+)?skip/i,
      /^another\s+question/i,
      /^new\s+question/i,
      /^change\s+(the\s+)?(topic|question)/i,
    ];
    
    const isSkipRequest = skipPatterns.some(p => p.test(userAnswerLower));
    
    if (isSkipRequest) {
      console.log('⏭️ Skip/move-on request detected - will generate fresh question');
      // Don't return here - let it flow through to generate a new question
      // But mark that we should ignore the user's message content for question generation
      req.body.userAnswer = '[SKIP_REQUEST]'; // Signal to generate fresh question
    }
    
    // Detect clarification request patterns
    const clarificationPatterns = [
      /repeat/i,
      /say\s+(that\s+)?again/i,
      /come\s+again/i,
      /didn'?t\s+(hear|understand|get|catch)/i,
      /can'?t\s+(hear|understand)/i,
      /pardon/i,
      /what\s+(did\s+you|was\s+that)/i,
      /could\s+you\s+(please\s+)?(repeat|say)/i,
      /one\s+more\s+time/i,
      /again\s*\??$/i,
    ];
    
    const elaborationPatterns = [
      /elaborate/i,
      /explain\s+(more|further|that)/i,
      /clarif(y|ication)/i,
      /more\s+(detail|specific|context)/i,
      /what\s+do\s+you\s+mean/i,
      /can\s+you\s+(be\s+more\s+)?specific/i,
      /not\s+sure\s+(what|i)\s+understand/i,
      /rephrase/i,
      /different\s+way/i,
    ];
    
    const isRepeatRequest = !isSkipRequest && clarificationPatterns.some(p => p.test(userAnswerLower));
    const isElaborateRequest = !isSkipRequest && elaborationPatterns.some(p => p.test(userAnswerLower));
    
    if (isRepeatRequest || isElaborateRequest) {
      console.log('🔄 Clarification request detected:', isRepeatRequest ? 'REPEAT' : 'ELABORATE');
      console.log('📋 Conversation length:', conversation?.length || 0);
      
      // Find the last ACTUAL question asked from conversation history
      // Skip short feedback messages like "Good", "Nice", "Solid"
      let lastQuestion = null;
      if (conversation && conversation.length > 0) {
        // Look for the last assistant message that looks like a question
        // Handle both formats: {role, content} and {type, text}
        for (let i = conversation.length - 1; i >= 0; i--) {
          const msg = conversation[i];
          const msgRole = msg.role || msg.type;
          const msgContent = (msg.content || msg.text || '').trim();
          
          console.log(`   [${i}] ${msgRole}: "${msgContent?.substring(0, 50)}..."`);
          
          if (msgRole === 'assistant' && msgContent) {
            // Check if this looks like a real question (not just short feedback)
            const isActualQuestion = 
              msgContent.includes('?') || // Has question mark
              msgContent.length > 30 ||   // Longer than typical feedback
              msgContent.toLowerCase().startsWith('what') ||
              msgContent.toLowerCase().startsWith('how') ||
              msgContent.toLowerCase().startsWith('why') ||
              msgContent.toLowerCase().startsWith('can you') ||
              msgContent.toLowerCase().startsWith('tell me') ||
              msgContent.toLowerCase().startsWith('describe');
            
            if (isActualQuestion) {
              lastQuestion = msgContent;
              console.log('📌 Found last question from conversation:', lastQuestion?.substring(0, 80) + '...');
              break;
            }
          }
        }
      }
      
      // Fallback 1: Use currentQuestion from request body
      if (!lastQuestion && req.body.currentQuestion) {
        lastQuestion = req.body.currentQuestion;
        console.log('📌 Using currentQuestion from request:', lastQuestion?.substring(0, 80) + '...');
      }
      
      // Fallback 2: If still no question, check any assistant message
      if (!lastQuestion && conversation && conversation.length > 0) {
        for (let i = conversation.length - 1; i >= 0; i--) {
          const msg = conversation[i];
          const msgRole = msg.role || msg.type;
          const msgContent = (msg.content || msg.text || '').trim();
          
          if (msgRole === 'assistant' && msgContent && msgContent.length > 10) {
            lastQuestion = msgContent;
            console.log('📌 Using fallback assistant message:', lastQuestion?.substring(0, 80) + '...');
            break;
          }
        }
      }
      
      if (lastQuestion) {
        let responseText;
        
        if (isRepeatRequest) {
          // Repeat the last question with a friendly prefix
          const repeatPrefixes = [
            "Sure, let me repeat that: ",
            "Of course! Here's the question again: ",
            "No problem, here it is again: ",
            "Absolutely! ",
          ];
          const prefix = repeatPrefixes[Math.floor(Math.random() * repeatPrefixes.length)];
          responseText = prefix + lastQuestion;
        } else {
          // Elaborate/rephrase - use LLM to rephrase the question
          try {
            const rephraseResponse = await openai.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [
                { 
                  role: 'system', 
                  content: 'You are an interview assistant. The candidate asked for clarification on a question. Rephrase the question below in a clearer, more detailed way. Keep it as ONE question. Add helpful context if needed but stay focused on the same topic. Do not change the core meaning of the question.'
                },
                { 
                  role: 'user', 
                  content: `Please rephrase this interview question more clearly:\n\n"${lastQuestion}"\n\nProvide the rephrased question with a brief clarification prefix.`
                }
              ],
              max_tokens: 150,
              temperature: 0.5,
            });
            responseText = rephraseResponse.choices[0].message.content || lastQuestion;
            // Clean up the response
            responseText = responseText.replace(/^["']|["']$/g, '').trim();
          } catch (rephraseErr) {
            console.error('Rephrase error:', rephraseErr);
            // Fallback: just repeat with a clarification note
            responseText = `Let me clarify: ${lastQuestion}`;
          }
        }
        
        console.log('✅ Responding to clarification request:', responseText.slice(0, 100));
        
        // Return in batch format if batchCount was requested, otherwise single response
        const clarifyBatchCount = Math.max(1, Math.min(Number(req.body.batchCount) || 1, 3));
        if (clarifyBatchCount > 1) {
          return res.status(200).json({
            status: 'success',
            data: {
              response: responseText,
              responses: [responseText],
              clarificationHandled: true
            }
          });
        }
        
        return res.status(200).json({
          status: 'success',
          data: {
            response: responseText,
            clarificationHandled: true
          }
        });
      } else {
        // No previous question found, ask them to proceed
        const fallbackResponse = "I'd be happy to help! Could you please provide your answer or let me know which question you'd like me to clarify?";
        const clarifyBatchCount = Math.max(1, Math.min(Number(req.body.batchCount) || 1, 3));
        
        if (clarifyBatchCount > 1) {
          return res.status(200).json({
            status: 'success',
            data: {
              response: fallbackResponse,
              responses: [fallbackResponse],
              clarificationHandled: true
            }
          });
        }
        
        return res.status(200).json({
          status: 'success',
          data: {
            response: fallbackResponse,
            clarificationHandled: true
          }
        });
      }
    }

    // For follow-up questions, use the normal LLM flow
    // BUILD COMPACT SYSTEM PROMPT WITH JOB PRIORITIZATION
    let systemPrompt = modeConfig.systemPrompt;
    
    // Add job requirement prioritization if job is present
    if (jobPrompt && jobPrompt.trim()) {
      systemPrompt += '\n✅ PRIORITY: Ask about how their experience directly applies to THIS ROLE requirements. Make every question job-specific.';
      if (jobSkillsText) {
        systemPrompt += `\n✅ REQUIRED SKILLS (focus on these): ${jobSkillsText}.`;
      }
    }
    
    // Add core rules concisely
    const questionRule = requestedBatchCount > 1
      ? `\n📋 RULES: Output exactly ${requestedBatchCount} questions. No greetings, explanations, or extra text. Do NOT answer in first person. Each question must start with an interrogative word (Who/What/How/Why/Can/Do/Tell/Describe/Explain).`
      : '\n📋 RULES: Output ONE question only. No greetings, explanations, or multiple questions. Do NOT answer in first person. Start with interrogative word (Who/What/How/Why/Can/Do/Tell/Describe/Explain). Do NOT respond to what the candidate said - just ask the next question.';
    systemPrompt += questionRule;
    
    // For job-focused interviews (all cases), enforce strict job constraint
    if (jobPrompt) {
      systemPrompt += '\n🔴 CRITICAL: EVERY QUESTION MUST BE ABOUT JOB REQUIREMENTS. No generic questions. No topics not in the job description. NEVER answer or explain - ONLY ask questions.';
    } else if (!isStarterOrFree) {
      // For non-starter resume-only interviews, can ask resume-related questions
      systemPrompt += '\n📖 Ask about skills and experiences that match job requirements WHEN available, otherwise probe resume content. NEVER answer or explain - ONLY ask questions.';
    }
    
    // Add resume core skills focus for non-starter plans
    if (!isStarterOrFree && resumePrompt) {
      systemPrompt += '\n✅ RESUME CORE SKILLS: Prioritize questions about core skills explicitly listed in the resume. Use resume projects and experience to probe those core skills first.';
    }

    // Add starter rules if applicable
    if (isStarterOrFree) {
      systemPrompt += '\n⚠️  STARTER PACK: Job-focused only. Do NOT ask any resume-based questions. Only ask about job requirements and role-specific skills.';
      // Add Strict mode enhancement if this is Strict mode
      if (interviewMode === 'strict') {
        systemPrompt += STARTER_PACK_STRICT_RULE;
      }
    }

    // Add anti-hallucination rule
    systemPrompt += '\n🚫 ANTI-HALLUCINATION: Never mention projects/companies/systems unless explicitly in resume or context. For job-focused interviews, only ask about role responsibilities and required skills.';

    // For follow-up questions, add STRICT job-scope constraint
    if (jobPrompt && jobPrompt.trim()) {
      systemPrompt += `\n\n🎯 STRICT JOB SCOPE CONSTRAINT: Your questions MUST be about the job requirements below. Do NOT ask generic questions.` +
        `\n✓ ONLY ask about: specific required skills/technologies, responsibilities, job requirements` +
        `\n✗ NEVER ask about: generic topics, generic soft skills, company culture, benefits, non-technical topics` +
        `\n✓ Verify each question directly references something from the job requirements below`;
      
      // Add phase guidance for better structured interviews
      if (interviewMode === 'friendly') {
        systemPrompt += '\n\n📊 PHASE-BASED QUESTION FLOW (for this friendly interview):\nPhase 1 (Q1-5): Core technical skills mentioned in the job\nPhase 2 (Q6-12): Their experience with those skills/technologies\nPhase 3 (Q13-20): Behavioral - how they work, learn, handle challenges\n\nStay in the CURRENT PHASE based on how many questions have been asked.';
      } else if (interviewMode === 'moderate') {
        systemPrompt += '\n\n📊 STRUCTURED ASSESSMENT FLOW (for this professional interview):\nStage 1 (Q1-5): Core technical skills verification - ask about required tech/skills from job description\nStage 2 (Q6-12): Practical experience assessment - probe how they\'ve used those skills\nStage 3 (Q13+): Problem-solving approach - assess how they handle challenges related to the role\n\nProgress through stages naturally based on conversation depth. Stay focused on job requirements.';
      } else if (interviewMode === 'strict') {
        systemPrompt += '\n\n🔥 BRUTAL ASSESSMENT FLOW (for this UNCOMPROMISING interview):\nStage 1 (Q1-5): EXPERT-LEVEL MASTERY - Ask brutal questions about core required skills. Demand deep knowledge of essential technologies. Test what they\'ve actually BUILT at scale.\nStage 2 (Q6-12): ADVANCED WARFARE - Probe edge cases, failure modes, security implications, performance bottlenecks. Ask "What went wrong?" and "How would you optimize this?" questions. Test architectural decisions and trade-offs at scale.\nStage 3 (Q13+): EXPERT PROBLEM-SOLVING - Ask hard scenarios specific to the role. Test if they can reason through UNFAMILIAR problems. Demand they explain why their approach matters. Zero tolerance for surface answers - always probe deeper.\n\n⚠️  EXPECTATIONS: Expert-level knowledge ONLY. Deep production experience required. Ask about WHY choices matter, not just WHAT they know. Test their failures and what they learned. Probe security, performance, scalability. Reject surface-level knowledge.';
      }
    }

    // Build extended context with SHORT job and resume excerpts only
    const shortJob = jobPrompt 
      ? jobPrompt.split('\n').slice(0, 4).join('\n') 
      : '';
    const shortResume = resumePrompt 
      ? resumePrompt.split('\n').slice(0, 3).join('\n')
      : '';

    const batchInstruction = requestedBatchCount > 1
      ? `\n\nOUTPUT FORMAT: Return exactly ${requestedBatchCount} questions separated by "|||" with no numbering, no bullets, and no extra text.`
      : '';

    // Handle skip request - generate fresh question without referencing user's skip phrase
    const actualUserAnswer = req.body.userAnswer;
    const isSkipMode = actualUserAnswer === '[SKIP_REQUEST]';
    
    let userContent;
    if (isSkipMode) {
      userContent = `The candidate wants to move on to a different topic. Ask a NEW interview question about a different aspect of the job requirements. Do NOT reference the previous question or the candidate's request to skip.${batchInstruction}`;
    } else if (conversationContext) {
      userContent = `${conversationContext}\n\nThe candidate's latest response was: "${actualUserAnswer}"${batchInstruction}`;
    } else {
      userContent = `The candidate answered: "${actualUserAnswer}". Ask a follow-up question based on the job requirements ONLY.${batchInstruction}`;
    }

    // Call LLM with simplified payload
    let response;
    try {
      const messagesPayload = [
        { role: 'system', content: systemPrompt },
        ...(shortJob ? [{ role: 'system', content: `JOB SUMMARY:\n${shortJob}` }] : []),
        ...(shortResume ? [{ role: 'system', content: `RESUME SUMMARY:\n${shortResume}` }] : []),
        { role: 'user', content: userContent }
      ];
      console.log('📋 LLM Call - Mode:', interviewMode, '| Job present:', !!jobPrompt, '| Resume present:', !!resumePrompt);
      response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: messagesPayload,
        max_tokens: 80,
        temperature: modeConfig.temperature,  // Use mode-specific temperature
      });
    } catch (llmErr) {
      console.error('❌ LLM provider error during /api/ai/interview call:', llmErr && llmErr.message ? llmErr.message : llmErr);
      return res.status(502).json({ status: 'error', message: 'LLM provider error', error: llmErr?.message || String(llmErr) });
    }

    const aiResponseRaw = response.choices[0].message.content || '';
    if (requestedBatchCount > 1) {
      console.log('\n🔄 [BATCH] Processing Batch Response');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📝 Raw LLM Response:', aiResponseRaw);
      console.log('📏 Response length:', aiResponseRaw.length, 'chars');
      console.log('🎯 Expected questions:', requestedBatchCount);
      
      const responses = extractBatchQuestions(aiResponseRaw, requestedBatchCount);
      
      console.log('\n✂️ [BATCH] Question Extraction Results:');
      console.log('   📊 Questions extracted:', responses.length);
      responses.forEach((q, i) => {
        console.log(`   ${i + 1}. ${q}`);
      });
      
      const fallbackQuestion = enforceQuestionOnly(clampWords(aiResponseRaw, 200), 60);
      const normalizedResponses = responses.length ? responses : [fallbackQuestion];
      
      if (responses.length === 0) {
        console.log('\n⚠️ [BATCH] Extraction Failed - Using Fallback');
        console.log('   📝 Fallback:', fallbackQuestion);
      }
      
      console.log('\n✅ [BATCH] Final Response:');
      console.log('   📊 Total questions:', normalizedResponses.length);
      console.log('   📝 Questions being sent:');
      normalizedResponses.forEach((q, i) => {
        console.log(`      ${i + 1}. ${q}`);
      });
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      return res.status(200).json({
        status: 'success',
        data: {
          response: normalizedResponses[0],
          responses: normalizedResponses
        }
      });
    }

    let trimmedResponse = enforceQuestionOnly(clampWords(aiResponseRaw, 200), 60);

    // 🔍 LOG LLM RESPONSE (BEFORE VALIDATION)
    console.log('\n✅ LLM RESPONSE RECEIVED (BEFORE VALIDATION)');
    console.log('   📡 Provider:', llmProviderName);
    console.log('   🎯 Mode:', modeConfig.name, `(temp: ${modeConfig.temperature})`);
    console.log('   📏 Raw response length:', aiResponseRaw?.length || 0);
    console.log('   💬 Raw:', aiResponseRaw?.slice(0, 150) || '(null)');
    console.log('   ✂️  Trimmed:', trimmedResponse);
    console.log('   ⏱️  Tokens: ~', Math.ceil((aiResponseRaw?.length || 0) / 4));
    console.log('   ℹ️  Note: Will now validate format, hallucination, etc. Final question may differ.');

    // Validator: detect non-question content before/after the first question mark
    const firstQ = typeof aiResponseRaw === 'string' ? aiResponseRaw.indexOf('?') : -1;
    const hasNonQuestionBefore = firstQ > -1 && /[.!]/.test(aiResponseRaw.slice(0, firstQ).replace(/\s+/g, ''));
    const hasExtraAfter = firstQ > -1 && aiResponseRaw.slice(firstQ + 1).trim().length > 0;
    const answerLike = isAnswerLike(aiResponseRaw) || isAnswerLike(trimmedResponse);

    // If the model returned a non-question or included answers (before/after), retry once with an explicit instruction
    if (!trimmedResponse || !trimmedResponse.trim().endsWith('?') || hasNonQuestionBefore || hasExtraAfter || answerLike) {
      console.log('⚠️  Format validation FAILED - regenerating...');
      console.log('   - Ends with ?:', trimmedResponse?.trim().endsWith('?'));
      console.log('   - Non-Q before:', hasNonQuestionBefore);
      console.log('   - Extra after:', hasExtraAfter);
      console.log('   - Answer-like:', answerLike);
      try {
        const regenSystem = systemPrompt + '\nIMPORTANT: Output exactly ONE QUESTION and NOTHING ELSE. If your previous response included an answer, discard it and generate only a concise interview question.';
        const regenResp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: regenSystem },
            { role: 'user', content: conversationContext 
              ? `${conversationContext}\n\nThe candidate's latest response was: "${userAnswer}"`
              : `The candidate answered: "${userAnswer}". Ask a follow-up question based on the job requirements ONLY. Keep it under 60 words, one sentence.` }
          ],
          max_tokens: 80,
          temperature: Math.max(0.1, modeConfig.temperature - 0.2),  // Reduce temp for stricter format
        });

        const regenText = regenResp.choices[0].message.content;
        const regenTrim = enforceQuestionOnly(clampWords(regenText, 200), 60);
        const regenFirstQ = typeof regenText === 'string' ? regenText.indexOf('?') : -1;
        const regenHasNonQuestionBefore = regenFirstQ > -1 && /[.!]/.test(regenText.slice(0, regenFirstQ).replace(/\s+/g, ''));
        const regenHasExtraAfter = regenFirstQ > -1 && regenText.slice(regenFirstQ + 1).trim().length > 0;
        if (regenTrim && regenTrim.trim().endsWith('?') && !regenHasNonQuestionBefore && !regenHasExtraAfter) {
          trimmedResponse = regenTrim;
          console.log('✅ Format regeneration SUCCESS:', regenTrim);
        } else {
          console.log('❌ Format regeneration FAILED, regen output:', regenTrim);
        }
      } catch (regenErr) {
        console.warn('Regeneration attempt failed:', regenErr?.message || regenErr);
      }
    }

    // Hallucination detection: ensure named entities in the response exist in allowed context
    try {
      const allowedContext = `${jobPrompt || ''} ${resumePrompt || ''} ${companyQuestionContext || ''} ${conversationContext || ''}`;
      const hallucinated = detectHallucinatedEntities(trimmedResponse || aiResponseRaw, allowedContext);
      if (hallucinated) {
        console.log('🛑 HALLUCINATION DETECTED:', hallucinated);
        try {
          const antiHallSys = systemPrompt + '\n\n!!! CRITICAL INSTRUCTION !!!\nYou are the INTERVIEWER. Your ONLY job is to ASK A QUESTION.\nDo NOT answer the candidate. Do NOT explain anything. Do NOT share your thoughts.\nDo NOT start with "I", "We", "During", "In my", "At", etc.\nDo NOT mention projects/companies/systems NOT in the job description.\nOutput EXACTLY ONE QUESTION:\n- Start with interrogative: Who/What/How/Why/Can/Do/Tell/Describe/Explain\n- End with ?\n- Nothing else\n- No preamble, no explanation, no extra text';
          const antiResp = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: antiHallSys },
                { role: 'user', content: 'Ask ONE interview question about their experience with job requirements. ONLY output the question. Nothing else.' }
            ],
            max_tokens: 80,
            temperature: Math.max(0.05, modeConfig.temperature - 0.3)
          });
          const antiText = antiResp.choices[0].message.content || '';
          const antiTrim = enforceQuestionOnly(clampWords(antiText, 200), 60);
          const stillHall = detectHallucinatedEntities(antiText, allowedContext);
          if (antiTrim && antiTrim.trim().endsWith('?') && !stillHall) {
            trimmedResponse = antiTrim;
            console.log('✅ Anti-hallucination regeneration SUCCESS');
          } else {
            console.log('❌ Anti-hallucination regeneration FAILED, using fallback');
            // Fallback safe question: job-focused question using required skills when possible
            const fallback = jobSkillsText
              ? `Which of these required skills have you used most: ${jobSkillsText}?`
              : (cleanJobTitle ? `Which requirement from the ${cleanJobTitle} job description do you have the most hands-on experience with?` : 'Which requirement from the job description do you have the most hands-on experience with?');
            trimmedResponse = enforceQuestionOnly(fallback, 60);
          }
        } catch (e) {
          console.warn('Anti-hallucination regeneration failed:', e?.message || e);
        }
      }
    } catch (e) {
      console.warn('Hallucination detection failed:', e?.message || e);
    }

    // Strict question validation: ensure output begins with interrogative and is a real question
    try {
      if (!isValidQuestion(trimmedResponse)) {
        console.log('❌ VALIDATION FAILED - Question is not valid interrogative');
        console.log('   - Current:', trimmedResponse);
        console.log('   - Attempting deterministic regeneration...');
        const regenSys = systemPrompt + '\nIMPORTANT: Start the output with an interrogative word (Who/What/How/Why/When/Describe/Explain/Can/Do/Are) and output EXACTLY ONE concise question. DO NOT echo resume headings or markdown.';
        const regenResp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: regenSys },
            { role: 'user', content: conversationContext ? `${conversationContext}\n\nThe candidate's latest response was: "${userAnswer}"` : `The candidate answered: "${userAnswer}". Ask a follow-up question based on the job requirements ONLY. Keep it under 60 words, one sentence.` }
          ],
          max_tokens: 80,
          temperature: Math.max(0.05, modeConfig.temperature - 0.3)
        });
        const regenText = regenResp.choices[0].message.content || '';
        const regenTrim = enforceQuestionOnly(clampWords(regenText, 200), 60);
        if (isValidQuestion(regenTrim)) {
          trimmedResponse = regenTrim;
          console.log('✅ Validation regeneration SUCCESS:', regenTrim);
        } else {
          console.log('❌ Validation regeneration FAILED, using fallback');
          // fallback safe question
          const fallback = jobSkillsText
            ? `Which of these required skills have you used most: ${jobSkillsText}?`
            : (cleanJobTitle ? `Which requirement from the ${cleanJobTitle} job description do you have the most hands-on experience with?` : 'Which requirement from the job description do you have the most hands-on experience with?');
          trimmedResponse = enforceQuestionOnly(fallback, 60);
          console.log('Using fallback question due to repeated validation failure');
        }
      }
    } catch (e) {
      console.warn('Question validation/regeneration failed:', e?.message || e);
    }

    // Avoid repeating the last assistant question: if model output equals last assistant question, use alternative fallback
    try {
      const recentAssistantQuestions = [];
      if (conversation && Array.isArray(conversation)) {
        for (let i = conversation.length - 1; i >= 0; i--) {
          if (conversation[i].type !== 'user' && conversation[i].text) {
            recentAssistantQuestions.push(conversation[i].text);
            if (recentAssistantQuestions.length >= 3) break;
          }
        }
      }
      const aNorm = normalizeForCompare(trimmedResponse || '');
      const isRepeat = recentAssistantQuestions.some((q) => overlapSimilarity(aNorm, normalizeForCompare(q)) >= 0.75);
      if (recentAssistantQuestions.length && isRepeat) {
        console.log('🔄 REPEAT DETECTED!');
        console.log('   - Current:', trimmedResponse);
        console.log('   - Recent:', recentAssistantQuestions[0]);
        console.log('   - Requesting alternative...');
        try {
          const lastAssistantQuestion = recentAssistantQuestions[0] || '';
          const noRepeatSys = systemPrompt + '\nIMPORTANT: Do NOT repeat or re-ask any of these recent assistant questions: "' + recentAssistantQuestions.join('" | "').replace(/\"/g, '') + '". Ask a different follow-up that probes another aspect of the candidate\'s experience.';
          const noRepeatResp = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: noRepeatSys },
              { role: 'user', content: conversationContext ? `${conversationContext}\n\nThe candidate's latest response was: "${userAnswer}"` : `The candidate answered: "${userAnswer}". Ask a follow-up question based on their experience.` }
            ],
            max_tokens: 90,
            temperature: Math.min(0.7, modeConfig.temperature + 0.3)
          });
          const altText = noRepeatResp.choices[0].message.content || '';
          const altTrim = enforceQuestionOnly(clampWords(altText, 200), 60);
          const altNorm = normalizeForCompare(altTrim);
          const altRepeat = recentAssistantQuestions.some((q) => overlapSimilarity(altNorm, normalizeForCompare(q)) >= 0.75);
          if (isValidQuestion(altTrim) && !altRepeat) {
            trimmedResponse = altTrim;
            console.log('✅ No-repeat regeneration SUCCESS:', altTrim);
          } else {
            console.log('❌ No-repeat regeneration FAILED, using unique fallback');
            const fallbackVariants = [
              jobSkillsText ? `Which of these required skills have you used most: ${jobSkillsText}?` : null,
              jobPrompt ? `How would you approach the key challenges mentioned in this role's requirements?` : `Tell me about another relevant project or experience from your background.`,
              jobPrompt ? `Can you explain your experience with any of the required technologies for this position?` : `What technical skills are you most proud of?`,
              jobPrompt ? `How do you stay updated with industry trends relevant to this role?` : `What has been your biggest professional achievement?`,
              jobPrompt ? `Describe a time when you solved a problem related to the responsibilities of this role.` : `How do you approach learning new technologies?`
            ].filter(Boolean);
            const randomFallback = fallbackVariants.find((q) => {
              const qNorm = normalizeForCompare(q);
              return !recentAssistantQuestions.some((r) => overlapSimilarity(qNorm, normalizeForCompare(r)) >= 0.75);
            }) || fallbackVariants[0];
            trimmedResponse = enforceQuestionOnly(randomFallback, 60);
          }
        } catch (nrErr) {
          console.warn('No-repeat regeneration failed:', nrErr?.message || nrErr);
          const fallbackVariants = [
            jobSkillsText ? `Which of these required skills have you used most: ${jobSkillsText}?` : null,
            jobPrompt ? `How would you approach the key challenges mentioned in this role's requirements?` : `Tell me about another relevant project or experience from your background.`,
            jobPrompt ? `Can you explain your experience with any of the required technologies for this position?` : `What technical skills are you most proud of?`,
            jobPrompt ? `How do you stay updated with industry trends relevant to this role?` : `What has been your biggest professional achievement?`,
            jobPrompt ? `Describe a time when you solved a problem related to the responsibilities of this role.` : `How do you approach learning new technologies?`
          ].filter(Boolean);
          const randomFallback = fallbackVariants.find((q) => {
            const qNorm = normalizeForCompare(q);
            return !recentAssistantQuestions.some((r) => overlapSimilarity(qNorm, normalizeForCompare(r)) >= 0.75);
          }) || fallbackVariants[0];
          trimmedResponse = enforceQuestionOnly(randomFallback, 60);
        }
      }
    } catch (e) {
      console.warn('Repeat detection failed:', e?.message || e);
    }

    // Sanitize final response to remove any leftover markdown/headings
    const preSanitizedQuestion = trimmedResponse;
    trimmedResponse = sanitizeText(trimmedResponse);
    if (!trimmedResponse || !trimmedResponse.trim()) {
      console.warn('Interview response sanitized to empty — using fallback response');
      trimmedResponse = cleanJobTitle
        ? `Tell me about a project or task where you used the key technologies for the ${cleanJobTitle} role.`
        : 'Tell me about a project or task where you used the key technologies for this role.';
    }
    
    // 📤 LOG FINAL QUESTION BEING RETURNED
    if (preSanitizedQuestion !== trimmedResponse) {
      console.log('⚠️  FINAL ANSWER MODIFIED');
      console.log('   - Before sanitization:', preSanitizedQuestion);
      console.log('   - After sanitization:', trimmedResponse);
    } else {
      console.log('✅ FINAL QUESTION (no modifications after validation):', trimmedResponse);
    }
    console.log('═══════════════════════════════════════════');
    
    res.status(200).json({
      status: 'success',
      data: {
        response: trimmedResponse
      }
    });
  } catch (error) {
    console.error('OpenAI API error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to get AI response',
      error: error.message
    });
  }
}));

// Helper function to get mode configuration
const getModeConfig = (mode) => {
  const configs = {
    friendly: {
      name: "Friendly & Supportive",
      temperature: 0.6,  // Higher temp for warm, varied responses
      systemPrompt: `You are a FRIENDLY, ENCOURAGING interviewer. Your goal is to make the candidate feel comfortable while assessing their fit.

✅ TONE: Warm, supportive, genuinely interested in their background. Ask follow-ups that show you're listening.
✅ QUESTION FLOW: Ask ONE question at a time. Build on their answers naturally.
✅ JOB-FOCUSED: Every question must relate directly to the job requirements provided.

⚠️  STRICT CONSTRAINT: Ask ONLY about required skills, technologies, or responsibilities in the job description. NO generic questions. NO system design unless mentioned in job. NO resume-diving unless directly relevant to job fit.`
    },
    moderate: {
      name: "Balanced & Professional",
      temperature: 0.35,  // Balanced temp for consistent, professional responses
      systemPrompt: `You are a PROFESSIONAL interviewer conducting a structured assessment. Your goal is to assess fit for the role while maintaining professional standards.

✅ TONE: Straightforward, professional, focused on job fit. Ask substantive follow-ups based on their experience.
✅ QUESTION FLOW: Ask ONE question at a time. Probe their relevant experience and technical fit.
✅ JOB-FOCUSED: Every question must directly relate to the job requirements provided.
✅ QUESTION ONLY: Do NOT answer, explain, or share your thoughts. ONLY ask interview questions.
✅ STRUCTURE: Start with interrogative word (Who/What/How/Why/Can/Do/Tell/Describe/Explain) and end with ?.

⚠️  STRICT CONSTRAINT: You are the INTERVIEWER asking questions. Do NOT respond to candidate answers - only generate the NEXT question. Do NOT answer in first person. Do NOT mention projects/companies/systems unless in the job description. All questions must directly connect to the job's required skills, technologies, or responsibilities.`
    },
    strict: {
      name: "Strict & Rigorous",
      temperature: 0.1,  // VERY LOW temp for deterministic, uncompromising responses
      systemPrompt: `You are an UNCOMPROMISING technical interviewer testing EXPERT-LEVEL mastery only. REJECT weak answers. DEMAND deep reasoning.

🔥 ROLE: You are NOT here to be fair. You are here to find if this candidate can TRULY HANDLE THIS ROLE at an expert level.

✅ TONE: Aggressive, unforgiving, demanding. No encouragement. No sympathy. Probe mercilessly for depth.
✅ QUESTION FLOW: Ask ONE BRUTALLY DIFFICULT question. Expect expert-level response. 
✅ JOB-FOCUSED: EVERY single question must test a CRITICAL REQUIRED SKILL from job description.
✅ UNFORGIVING: Zero tolerance for surface-level answers. Challenge shallow responses immediately.
✅ DEPTH OBSESSION: Go DEEP. Ask about why choices matter. Ask about failure modes. Ask about scaling limits.
✅ SCENARIO-BASED: Ask "What would you do with [HARD CONSTRAINT]?" to reveal true mastery.
✅ QUESTION ONLY: NEVER explain, validate, or soften. ONLY ask the next brutally honest question.

🚨 MANDATORY QUESTION ELEMENTS:
- Edge cases AND boundary conditions AND failure scenarios
- Performance implications AND optimization trade-offs AND scaling limits
- Security implications AND attack vectors AND defensive strategies
- Why specific choices matter AND what happens if they fail AND cost of being wrong
- Hands-on debugging AND root cause analysis AND production incident handling
- Advanced patterns AND anti-patterns AND common mistakes at scale

⚠️  UNCOMPROMISING REQUIREMENTS:
- REJECT "I don't know" - ask them to reason through it
- REJECT generic answers - demand specificity and examples
- REJECT surface knowledge - always probe deeper with "Why?" and "What if?"
- REJECT vague responses - demand details about actual implementation
- NEVER ask basic questions - ONLY expert-level technical depth
- NEVER assume junior knowledge exists - probe like they should be senior
- Test if they've actually DONE this at scale, not just learned it
- Ask about production failures, lessons learned, mistakes made
- Test their ability to handle UNFAMILIAR problems with known tools`
    }
  };

  return configs[mode] || configs.moderate;
};

// @desc    Text-to-Speech endpoint
// @route   POST /api/ai/tts
// @access  Private
router.post('/tts', authenticateToken, asyncHandler(async (req, res) => {
  console.log('=== TTS REQUEST ===');
  
  const { text, voice = 'aura-2-helena-en' } = req.body;

  if (!deepgram) {
    return res.status(500).json({
      status: 'error',
      message: 'Deepgram API key not configured on server'
    });
  }

  // Sanitize incoming text to remove markdown/heading noise
  const safeIncomingText = sanitizeText(text || '');
  if (!safeIncomingText) {
    console.warn('TTS request received with empty or sanitized-to-empty text. Falling back to generic prompt.');
    // Use a safe generic fallback question to speak instead of failing
    // Prefer a fallback provided by caller, else derive a generic job-focused prompt
    const fallback = req.body.fallback || 'Can you tell me about your experience with the key requirements for this role?';
    // Use fallback as the text to synthesize
    req.body.text = fallback;
  } else {
    // replace with sanitized version
    req.body.text = safeIncomingText;
  }

  try {
    logLLMRequest('text-to-speech');

    // Deepgram limit ~2000 chars; also clamp to 200 words to avoid rambling
    const wordClamped = clampWords(req.body.text, 200);
    const safeText = wordClamped.length > 1900 ? wordClamped.slice(0, 1900) : wordClamped;

    // Map any non-Deepgram voice names (e.g., OpenAI alloy) to a valid Deepgram Aura model
    const dgVoice = (voice && voice.startsWith('aura-')) ? voice : 'aura-2-helena-en';

    const speakResponse = await deepgram.speak.request(
      { text: safeText },
      {
        model: dgVoice, // Deepgram Aura voice
        encoding: 'mp3'
      }
    );

    if (speakResponse.error) {
      throw speakResponse.error;
    }

    const audioBuffer = Buffer.from(await speakResponse.result.arrayBuffer());
    const audioBase64 = audioBuffer.toString('base64');

    res.status(200).json({
      status: 'success',
      data: {
        audioBase64: audioBase64,
        voice: dgVoice
      }
    });
    
  } catch (error) {
    console.error('TTS API error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate speech',
      error: error.message
    });
  }
}));

// @desc    Audio transcription endpoint
// @route   POST /api/ai/transcribe
// @access  Private
router.post('/transcribe', authenticateToken, upload.single('audio'), asyncHandler(async (req, res) => {
  console.log('=== TRANSCRIPTION REQUEST ===');
  
  if (!deepgram) {
    return res.status(501).json({
      status: 'error',
      message: 'STT currently unavailable on this server. Set DEEPGRAM_API_KEY to enable transcription.'
    });
  }

  if (!req.file) {
    return res.status(400).json({
      status: 'error',
      message: 'Audio file is required'
    });
  }

  console.log('🎧 Audio file received:', {
    fieldname: req.file.fieldname,
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    bufferLength: req.file.buffer?.length
  });

  if (!req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({
      status: 'error',
      message: 'Audio file is empty or unreadable'
    });
  }

  try {
    console.log('🎙️ Transcribing with Deepgram...');

    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(req.file.buffer, {
      model: 'nova-2',
      smart_format: true,
      punctuate: true,
      language: 'en',
      diarize: false
    });

    if (error) {
      throw error;
    }

    const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    console.log('✅ Transcription complete:', transcript);

    res.status(200).json({
      status: 'success',
      data: {
        transcript: transcript,
        duration: req.file.size
      }
    });
    
  } catch (error) {
    console.error('❌ Transcription API error:', {
      message: error?.message,
      status: error?.status,
      code: error?.code,
      body: error?.body
    });
    const statusCode = error?.status && Number.isInteger(error.status) ? error.status : 502;
    res.status(statusCode).json({
      status: 'error',
      message: 'Failed to transcribe audio',
      error: error?.message || 'Unknown STT error'
    });
  }
}));

// @desc    Voice-based interview round (Audio in, Audio+Text out)
// @route   POST /api/ai/voice-round
// @access  Private
router.post('/voice-round', authenticateToken, upload.single('audio'), asyncHandler(async (req, res) => {
  console.log('=== VOICE INTERVIEW ROUND ===');
  console.log('📥 Request received from:', req.ip);
  console.log('📦 Body fields:', Object.keys(req.body));
  console.log('🎵 Audio file:', req.file ? {
    fieldname: req.file.fieldname,
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    buffer_length: req.file.buffer?.length
  } : 'NO FILE');
  
  const { role, resumeText, sessionId, jobTitle, company } = req.body;
  const safeJobTitle = sanitizeText(jobTitle || '').replace(/[^a-zA-Z0-9\s-]/g, '').trim();
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.error('❌ OpenAI API key not configured');
    return res.status(500).json({
      status: 'error',
      message: 'OpenAI API key not configured on server'
    });
  }

  if (!req.file) {
    console.error('❌ No audio file in request');
    return res.status(400).json({
      status: 'error',
      message: 'Audio file is required'
    });
  }

  if (!role || !sessionId) {
    console.error('❌ Missing required fields - role:', role, 'sessionId:', sessionId);
    return res.status(400).json({
      status: 'error',
      message: 'role and sessionId are required'
    });
  }

  try {
    // Step 1: Transcribe audio using Whisper
    console.log('🎤 Transcribing audio (Deepgram)...');

    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(req.file.buffer, {
      model: 'nova-2',
      smart_format: true,
      punctuate: true,
      language: 'en',
      diarize: false
    });

    if (error) {
      throw error;
    }

    const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    console.log('📝 Transcript:', transcript);

    // Step 2: Get mode configuration
    const modeConfig = getModeConfig(role);
    
    // Step 3: Generate AI response using transcript and context
    console.log('🤖 Generating AI response...');
    const isStarterOrFree = req.user?.plan === 'STARTER' || req.user?.plan === 'FREE';
    // Append starter safety rule along with existing starter negatives for Starter/Free plans
    let starterNote = isStarterOrFree ? (STARTER_NEGATIVE_RULES + STARTER_PACK_SAFETY_RULE) : '';
    // Add Strict mode enhancement if this is Strict mode
    if (isStarterOrFree && role === 'strict') {
      starterNote += STARTER_PACK_STRICT_RULE;
    }

    // If both job context and resume text exist, make resume defer to the target job
    let resumeContext = resumeText || '';
    if ((jobTitle || company) && resumeContext) {
      resumeContext = `\n\nNOTE: TARGET JOB PRIORITY - When a target job is provided, PRIORITIZE the job's requirements in your questions. Use resume content only to support job-focused questions (examples/projects/skills that map to the job).\n` + resumeContext;
    }

    // Sanitize resume context to avoid heading/markdown echoing
    resumeContext = sanitizeText(resumeContext);

    // If caller provided a conversation array, compute number of interviewer questions asked so far
    const numQuestionsAskedVoice = Array.isArray(req.body.conversation) ? req.body.conversation.filter(m => m.type !== 'user').length : 0;
    const postTenPromptVoice = numQuestionsAskedVoice >= 10 ? CORE_SKILLS_THEN_HR : '';

    let contextPrompt = `${modeConfig.systemPrompt}\n${QUESTION_RULES}${PRIORITIZE_TARGET_JOB}\nKeep follow-ups concise: no more than 2 sentences and under 50 words.${postTenPromptVoice}${starterNote}${ANTI_HALLUCINATION_RULE}${HARD_QUESTION_ONLY}`;
    
    // Add job context
    if (jobTitle || company) {
      contextPrompt += `\n\nJOB CONTEXT:\nPosition: ${jobTitle || 'Not specified'}${company ? ` at ${company}` : ''}`;
    }
    
    // Add resume context
    if (resumeContext) {
      contextPrompt += `\n\nCANDIDATE RESUME CONTEXT:\n${resumeContext}`;
    }
    // Build compact prompts for voice follow-ups (limit resume/job and conversation scope)
    logLLMRequest('interview follow-up (voice)');
    let compactSystem = `${modeConfig.systemPrompt}\nRULES: Output exactly ONE interview question and nothing else. Keep it concise.`;
    if (shortJob && shortJob.trim()) {
      compactSystem += `\nFOCUS: When JOB SUMMARY is present, PRIORITIZE the job's required skills and responsibilities when crafting the question.`;
    }
    console.log('LLM Call (voice) - shortJob:', shortJob ? shortJob : 'NONE');
    console.log('LLM Call (voice) - shortResume:', shortResume ? shortResume : 'NONE');
    const shortJob = (jobTitle || company) ? `Role: ${jobTitle || 'Not specified'}${company ? ` at ${company}` : ''}` : '';
    const shortResume = resumeContext ? sanitizeText(resumeContext).split('\n').slice(0,6).join('\n').slice(0,400) : '';
    const userMsg = `The candidate answered: "${transcript}". Ask a relevant follow-up question to continue the interview. Keep it under 2 sentences and under 50 words. Follow all question rules strictly.`;

    const aiResponseCall = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: compactSystem },
        ...(shortJob ? [{ role: 'system', content: `JOB SUMMARY:\n${shortJob}` }] : []),
        ...(shortResume ? [{ role: 'system', content: `RESUME SUMMARY:\n${shortResume}` }] : []),
        { role: 'user', content: userMsg }
      ],
      max_tokens: 70,
      temperature: modeConfig.temperature,  // Use mode-specific temperature
    });

    const aiTextRaw = aiResponseCall.choices[0].message.content;
    let aiText = enforceQuestionOnly(clampWords(aiTextRaw, 200), 60); // Enforce single short question

    // Validator: check for non-question content before/after first question mark
    const firstQ = typeof aiTextRaw === 'string' ? aiTextRaw.indexOf('?') : -1;
    const hasNonQuestionBefore = firstQ > -1 && /[.!]/.test(aiTextRaw.slice(0, firstQ).replace(/\s+/g, ''));
    const hasExtraAfter = firstQ > -1 && aiTextRaw.slice(firstQ + 1).trim().length > 0;

    // If not a clean single-question response, retry once with explicit instruction
    if (!aiText || !aiText.trim().endsWith('?') || hasNonQuestionBefore || hasExtraAfter) {
      try {
        const regenSystem = contextPrompt + '\nIMPORTANT: Output exactly ONE QUESTION and NOTHING ELSE. If your previous response included an answer, discard it and generate only a concise interview question.';
        const regenResp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: regenSystem },
            { role: 'user', content: `The candidate answered: "${transcript}". Ask a relevant follow-up question to continue the interview. Keep it under 2 sentences and under 50 words. Follow all question rules strictly.` }
          ],
          max_tokens: 90,
          temperature: Math.max(0.1, modeConfig.temperature - 0.2)  // Reduce temp for stricter format
        });
        const regenText = regenResp.choices[0].message.content;
        const regenTrim = enforceQuestionOnly(clampWords(regenText, 200), 60);
        const regenFirstQ = typeof regenText === 'string' ? regenText.indexOf('?') : -1;
        const regenHasNonQuestionBefore = regenFirstQ > -1 && /[.!]/.test(regenText.slice(0, regenFirstQ).replace(/\s+/g, ''));
        const regenHasExtraAfter = regenFirstQ > -1 && regenText.slice(regenFirstQ + 1).trim().length > 0;
        if (regenTrim && regenTrim.trim().endsWith('?') && !regenHasNonQuestionBefore && !regenHasExtraAfter) aiText = regenTrim;
      } catch (e) {
        console.warn('Voice-round regeneration failed:', e?.message || e);
      }
    }
    // Hallucination detection for voice-round responses
    try {
      const allowedContext = `${contextPrompt || ''} ${jobTitle || ''} ${company || ''} ${resumeContext || ''}`;
      const hallucinated = detectHallucinatedEntities(aiTextRaw, allowedContext);
      if (hallucinated) {
        console.warn('🛑 Hallucinated entities detected in voice-round response:', hallucinated);
        try {
          const antiSys = contextPrompt + '\nDO NOT INVENT OR MENTION PROJECTS, COMPANIES, OR SYSTEMS NOT PRESENT IN THE PROVIDED CONTEXT. OUTPUT ONLY A SINGLE QUESTION.';
          const antiResp = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: antiSys },
              { role: 'user', content: `The candidate answered: "${transcript}". Ask a relevant follow-up question to continue the interview. Keep it under 2 sentences and under 50 words. Follow all question rules strictly.` }
            ],
            max_tokens: 90,
            temperature: Math.max(0.1, modeConfig.temperature - 0.2)
          });

          const antiText = antiResp.choices[0].message.content || '';
          const antiTrim = enforceQuestionOnly(clampWords(antiText, 200), 60);
          const stillHall = detectHallucinatedEntities(antiText, allowedContext);
          if (antiTrim && antiTrim.trim().endsWith('?') && !stillHall) {
            aiText = antiTrim;
          } else {
            const fallback = safeJobTitle
              ? `Tell me about your experience with the key requirements for the ${safeJobTitle} role.`
              : 'Tell me about your experience with the key requirements for this role.';
            aiText = enforceQuestionOnly(fallback, 60);
          }
        } catch (e) {
          console.warn('Anti-hallucination regeneration (voice) failed:', e?.message || e);
        }
      }
    } catch (e) {
      console.warn('Voice-round hallucination detection failed:', e?.message || e);
    }
    // Strict validation: ensure aiText is an interrogative question
    try {
      if (!isValidQuestion(aiText)) {
        console.warn('❗ Voice-round question validation failed - attempting deterministic regeneration');
        const regenSys = contextPrompt + '\nIMPORTANT: Start the output with an interrogative word (Who/What/How/Why/When/Describe/Explain/Can/Do/Are) and output EXACTLY ONE concise question. DO NOT echo resume headings or markdown.';
        logLLMPayload('voice-round - regen validation', [{ role: 'system', content: regenSys }, { role: 'user', content: `The candidate answered: "${transcript}". Ask a relevant follow-up question to continue the interview. Keep it under 2 sentences and under 50 words.` }]);
        const regenResp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: regenSys },
            { role: 'user', content: `The candidate answered: "${transcript}". Ask a relevant follow-up question to continue the interview. Keep it under 2 sentences and under 50 words.` }
          ],
          max_tokens: 90,
          temperature: Math.max(0.05, modeConfig.temperature - 0.3)
        });
        const regenText = regenResp.choices[0].message.content || '';
        logLLMPayload('voice-round - regen response', regenResp.choices[0].message ? [regenResp.choices[0].message] : []);
        const regenTrim = enforceQuestionOnly(clampWords(regenText, 200), 60);
        if (isValidQuestion(regenTrim)) {
          aiText = regenTrim;
        } else {
          const fallback = safeJobTitle
            ? `Tell me about your experience with the key requirements for the ${safeJobTitle} role.`
            : 'Tell me about your experience with the key requirements for this role.';
          aiText = enforceQuestionOnly(fallback, 60);
          console.warn('Using fallback voice-round question due to repeated validation failure');
        }
      }
    } catch (e) {
      console.warn('Voice-round validation/regeneration failed:', e?.message || e);
    }
    // Avoid repeating the last assistant question in voice-round
    try {
      let lastAssistantQuestion = '';
      const conv = Array.isArray(req.body.conversation) ? req.body.conversation : [];
      for (let i = conv.length - 1; i >= 0; i--) {
        if (conv[i].type !== 'user' && conv[i].text) {
          lastAssistantQuestion = conv[i].text;
          break;
        }
      }
      if (lastAssistantQuestion) {
        const aNorm = normalizeForCompare(aiText || '');
        const bNorm = normalizeForCompare(lastAssistantQuestion || '');
        const sim = overlapSimilarity(aNorm, bNorm);
        if (aNorm && bNorm && sim >= 0.75) {
          console.warn('Detected repeated assistant question (voice); requesting alternative from model');
          try {
            const noRepeatSys = contextPrompt + '\nIMPORTANT: Do NOT repeat or re-ask the previous assistant question. The previous assistant question was: "' + lastAssistantQuestion.replace(/\"/g, '') + '". Ask a different follow-up that probes another aspect of the candidate\'s experience.';
            const noRepeatResp = await openai.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [
                { role: 'system', content: noRepeatSys },
                { role: 'user', content: `The candidate answered: "${transcript}". Ask a relevant follow-up question to continue the interview. Keep it under 2 sentences and under 50 words. Follow all question rules strictly.` }
              ],
              max_tokens: 90,
              temperature: Math.min(0.7, modeConfig.temperature + 0.3),
            });
            const alt = noRepeatResp.choices[0].message.content || '';
            const altTrim = enforceQuestionOnly(clampWords(alt, 200), 60);
            if (isValidQuestion(altTrim) && overlapSimilarity(normalizeForCompare(altTrim), bNorm) < 0.75) {
              aiText = altTrim;
            }
          } catch (nrErr) {
            console.warn('Voice no-repeat regeneration failed:', nrErr?.message || nrErr);
          }
        }
      }
    } catch (e) {
      console.warn('Voice repeat-detection failed:', e?.message || e);
    }
    console.log('📢 AI Response:', aiText);

    // Step 4: Generate speech from AI response using TTS
    console.log('🔊 Generating speech...');
    logLLMRequest('interview follow-up TTS');

    const ttsSafe = sanitizeText(clampWords(aiText, 200));
    const ttsResponse = await deepgram.speak.request(
      { text: ttsSafe.length > 1900 ? ttsSafe.slice(0, 1900) : ttsSafe },
      {
        model: 'aura-2-helena-en',
        encoding: 'mp3'
      }
    );

    if (ttsResponse.error) {
      throw ttsResponse.error;
    }

    const audioBuffer = Buffer.from(await ttsResponse.result.arrayBuffer());
    const audioBase64 = audioBuffer.toString('base64');

    console.log('✅ Voice round completed successfully');

    // Sanitize aiText before returning
    aiText = sanitizeText(aiText);

    res.status(200).json({
      status: 'success',
      data: {
        transcript: transcript,
        aiText: aiText,
        audioBase64: audioBase64,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Voice interview error:', error);
    console.error('Stack:', error.stack);
    res.status(500).json({
      status: 'error',
      message: 'Failed to process voice interview round',
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}));

// @desc    Get initial interview question
// @route   GET /api/ai/initial-question/:mode
// @access  Private
router.get('/initial-question/:mode', authenticateToken, asyncHandler(async (req, res) => {
  const { mode } = req.params;
  let { jobTitle = '', company = '', jobDescription = '', resumeId = '' } = req.query;
  console.log('🧭 [Initial Question] Query received:', { mode, jobTitle, company, hasJobDescription: !!jobDescription, jobDescriptionLength: jobDescription?.length || 0, resumeId });
  const apiKey = process.env.OPENAI_API_KEY;
  const userId = req.user.id;
  
  // Define isStarterOrFree early for use throughout endpoint
  const isStarterOrFree = req.user?.plan === 'STARTER' || req.user?.plan === 'FREE' || String(mode).toLowerCase() === 'starter';

  // Enforce: Starter/Free plans must NOT use resume content for initial questions
  try {
    const userPlan = req.user?.plan;
    if (userPlan === 'STARTER' || userPlan === 'FREE' || String(mode).toLowerCase() === 'starter') {
      if (resumeId) {
        console.log('ℹ️ [Initial Question] Ignoring resumeId for Starter/Free plan or starter mode request');
        resumeId = '';
      }
    }
  } catch (e) {
    console.warn('Could not enforce Starter resume rule:', e?.message || e);
  }

  if (!apiKey) {
    return res.status(500).json({
      status: 'error',
      message: 'OpenAI API key not configured on server'
    });
  }

  if (!jobDescription || !jobDescription.trim()) {
    return res.status(400).json({
      status: 'error',
      message: 'Job description (desc) is required to generate an initial question'
    });
  }

  try {
    const modeConfig = getModeConfig(mode);
    
    // Fetch resume data if resumeId provided - USE STRUCTURED DATA
    let fullResumeText = '';
    let structuredResumeData = null;
    let resumeAnalysis = null;
    if (resumeId) {
      try {
        console.log('🔍 [Initial Question] Loading resume:', resumeId);
        const resume = await Resume.findById(resumeId).select('rawText analysis parsedData');
        if (resume) {
          console.log('✅ [Initial Question] Resume loaded successfully');
          fullResumeText = resume.rawText || '';
          resumeAnalysis = resume.analysis || {};
          
          // Extract structured data
          structuredResumeData = {
            primaryRole: resumeAnalysis.primaryRole || 'Not specified',
            yearsOfExperience: resumeAnalysis.yearsOfExperience || 0,
            technicalSkills: resumeAnalysis.technicalSkills || [],
            projects: resumeAnalysis.projects || [],
            structuredExperience: resumeAnalysis.structuredExperience || []
          };
          
          console.log('📊 [Initial Question] Structured Data:');
          console.log('   - Projects:', structuredResumeData.projects.length);
          console.log('   - Experience:', structuredResumeData.structuredExperience.length);
          console.log('   - Parsed skills:', (resume.parsedData?.skills || []).length);
        } else {
          console.warn('❌ [Initial Question] Resume not found with ID:', resumeId);
          return res.status(400).json({
            status: 'error',
            message: 'Selected resume not found. Please re-upload or re-select your resume before starting the interview.'
          });
        }
      } catch (err) {
        console.warn(`⚠️  [Initial Question] Could not load resume: ${err.message}`);
      }
    }
    
    // Check for company-specific questions first (now AI-generated!)
    // COMMENTED OUT: Skip pre-generated questions, only use fresh Groq API
    let companyContext = '';
    let initialQuestion = null;
    
    /* DISABLED FOR TESTING - ONLY USE FRESH GROQ GENERATION
    if (company) {
      console.log(`🏢 [Initial Question] Requesting AI-generated questions for: ${company}`);
      const companyQuestions = await getCompanyQuestions(company, mode, jobTitle);
      if (companyQuestions && companyQuestions.questions.length > 0) {
        initialQuestion = pickRandom(companyQuestions.questions);
        companyContext = `\n\n🏢 COMPANY-SPECIFIC CONTEXT:\nThis is a realistic question generated by AI for ${companyQuestions.company} interviews.\nTailor your follow-up questions to this company and role.`;
        console.log(`✅ Using AI-generated ${company} interview question`);
      }
    }
    */
    
    // If no company-specific question found, generate one
    if (!initialQuestion) {
      // DISABLED FOR TESTING: Starter pack should NOT use resume context at all
      let resumePrompt = ''; // FORCE EMPTY FOR STARTER
      
      /* DISABLED: Resume context removed for Starter (job-focused only)
      if (fullResumeText && structuredResumeData) {
        let projectsList = '';
        if (structuredResumeData.projects && structuredResumeData.projects.length > 0) {
          projectsList = '\n\nPROJECTS EXPLICITLY MENTIONED IN RESUME:';
          structuredResumeData.projects.slice(0, 3).forEach((proj, idx) => {
            projectsList += `\n${idx+1}. ${proj.name}`;
            if (proj.technologies && proj.technologies.length > 0) {
              projectsList += ` (${proj.technologies.join(', ')})`;
            }
          });
        }
        
        let experienceList = '';
        if (structuredResumeData.structuredExperience && structuredResumeData.structuredExperience.length > 0) {
          experienceList = '\n\nWORK EXPERIENCE EXPLICITLY MENTIONED:';
          structuredResumeData.structuredExperience.slice(0, 2).forEach((exp, idx) => {
            experienceList += `\n${idx+1}. ${exp.jobTitle} at ${exp.company} (${exp.duration})`;
            if (exp.technologiesUsed && exp.technologiesUsed.length > 0) {
              experienceList += ` - ${exp.technologiesUsed.slice(0, 2).join(', ')}`;
            }
          });
        }
        
        resumePrompt = `\n\n📋 CANDIDATE RESUME DATA:
Full Resume Text:
${fullResumeText}

STRUCTURED EXTRACTION:
Primary Role: ${structuredResumeData.primaryRole}
Years of Experience: ${structuredResumeData.yearsOfExperience}
Technical Skills: ${structuredResumeData.technicalSkills.join(', ') || 'Not extracted'}
${projectsList}${experienceList}`;
      }
      */
      
      // Job context - FOCUS ONLY ON JOB REQUIREMENTS
      let jobContext = '';
      if (jobTitle || company || jobDescription) {
        jobContext = `\n\nTARGET POSITION:
Role: ${jobTitle || 'Not specified'}${company ? ` at ${company}` : ''}

Job Description:
${jobDescription || 'Not provided'}

CRITICAL: Generate opening question based ONLY on job requirements. Do NOT reference resume. Ask about their ability to meet this job's requirements.`;
      }
      
      // Build prompt with JOB-FOCUSED RULES ONLY (No Resume References)
      let combinedPrompt = '';
      
      if (mode === 'strict') {
        // STRICT MODE: Ask challenging, deep technical questions about job requirements
        combinedPrompt = `You are a RIGOROUS technical interviewer asking a challenging opening question.

${jobContext}

🔥 UNCOMPROMISING OPENING QUESTION (STRICT MODE):
1. Ask a BRUTALLY DIFFICULT question testing expert-level mastery
2. Focus on edge cases, failure modes, security, or architectural scaling
3. Ask "What happened when [hard scenario]?" or "How would you handle [constraint]?"
4. Demand they explain WHY their approach matters, not just HOW to do it
5. Reference specific technologies/frameworks and their limitations
6. Ask questions that reveal if they've actually BUILT at scale
7. Make it extremely specific and difficult - no room for generic answers
8. Keep it under 60 words but BRUTAL in expectation
9. Start with "Describe", "Explain", "Walk me through", "How would you"
10. This question should immediately reveal their true depth of knowledge`;
      } else {
        // FRIENDLY/MODERATE MODE: Approachable opening questions
        combinedPrompt = `You are a FRIENDLY interviewer asking opening questions.

${jobContext}

🎯 CRITICAL RULES FOR OPENING QUESTION:
1. Ask ONLY about the job requirements - NOT about resume
2. Ask about their ability to meet the role's requirements
3. Reference specific technologies/skills from the job description
4. Ask open-ended questions about their experience with relevant tech
5. Make it conversational and warm, not formal
6. Keep it concise - ONE clear question, under 60 words
7. Output exactly ONE question, NO explanations
8. Start with "Tell me", "Describe", "What's your experience", etc.
9. Make it specific to this job role and company
10. Do NOT ask generic questions`;
      }

      // Removed: Resume context is disabled for testing (resumePrompt is forced empty)
      
      // Build system prompt - Job-focused only for Starter
      let starterNote = isStarterOrFree ? '\n\n🎯 STARTER PACK MODE: Generate ONE opening question based ONLY on the job description. Do NOT reference any resume. Focus on job requirements.' : '';
      if (isStarterOrFree && mode === 'strict') {
        starterNote += STARTER_PACK_STRICT_RULE;
      }
      const systemPrompt = `${modeConfig.systemPrompt}\n${combinedPrompt}${starterNote}${ANTI_HALLUCINATION_RULE}`;

      logLLMRequest('opening question (Groq)');

      const modelName = llmProviderName === 'Groq' ? 'groq/mixtral-8x7b-32768' : 'gpt-4o-mini';

      const promptMessages = [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: `Generate ONE opening interview question for the ${jobTitle || 'target role'} position. Base it ONLY on the job requirements, not any resume. Make it warm and conversational. Output only the question, no explanation.`
        }
      ];

      const basePayload = {
        model: modelName,
        messages: promptMessages,
        max_tokens: 100,
        temperature: modeConfig.temperature,
      };

      console.log('🚀 Calling LLM with model:', modelName, '| Mode:', mode);
      const response = await openai.chat.completions.create(basePayload);

      initialQuestion = enforceQuestionOnly(clampWords(response.choices[0].message.content, 200), 40);

      // Detect answer-like content before/after the question and retry once if needed
      const raw = response.choices[0].message.content || '';
      const firstQ = typeof raw === 'string' ? raw.indexOf('?') : -1;
      const hasNonQuestionBefore = firstQ > -1 && /[.!]/.test(raw.slice(0, firstQ).replace(/\s+/g, ''));
      const hasExtraAfter = firstQ > -1 && raw.slice(firstQ + 1).trim().length > 0;

      if (!initialQuestion || !initialQuestion.trim().endsWith('?') || hasNonQuestionBefore || hasExtraAfter) {
        try {
          const regenSystem = systemPrompt + '\nIMPORTANT: Output exactly ONE QUESTION and NOTHING ELSE. If your previous response included an answer, discard it and generate only a concise interview question.';
          const regenResp = await openai.chat.completions.create({
            model: modelName,
            messages: [
              { role: 'system', content: regenSystem },
              { role: 'user', content: resumePrompt 
                  ? `Generate an opening question based on the candidate's resume and target position. Ask about specific projects or experience they've explicitly mentioned. Make it personalized and specific, not generic.`
                  : `Generate a professional opening interview question for the role of ${jobTitle || 'Software Engineer'}.` }
            ],
            max_tokens: 120,
            temperature: Math.max(0.1, modeConfig.temperature - 0.2),
          });

          const regenText = regenResp.choices[0].message.content;
          const regenTrim = enforceQuestionOnly(clampWords(regenText, 200), 40);
          const regenFirstQ = typeof regenText === 'string' ? regenText.indexOf('?') : -1;
          const regenHasNonQuestionBefore = regenFirstQ > -1 && /[.!]/.test(regenText.slice(0, regenFirstQ).replace(/\s+/g, ''));
          const regenHasExtraAfter = regenFirstQ > -1 && regenText.slice(regenFirstQ + 1).trim().length > 0;
          if (regenTrim && regenTrim.trim().endsWith('?') && !regenHasNonQuestionBefore && !regenHasExtraAfter) {
            initialQuestion = regenTrim;
          }
        } catch (e) {
          console.warn('Initial-question regeneration failed:', e?.message || e);
        }
      }

        // Strict validation: ensure initialQuestion is a valid interrogative
        try {
          if (!isValidQuestion(initialQuestion)) {
            console.warn('❗ Initial question validation failed - attempting deterministic regeneration');
            const regenSys = systemPrompt + '\nIMPORTANT: Start the output with an interrogative word (Who/What/How/Why/When/Describe/Explain/Can/Do/Are) and output EXACTLY ONE concise opening question. DO NOT echo resume headings or markdown.';
            logLLMPayload('initial-question - regen validation', [{ role: 'system', content: regenSys }, { role: 'user', content: resumePrompt ? `Generate an opening question based on the candidate's resume and target position.` : `Generate a professional opening interview question for the role of ${jobTitle || 'Software Engineer'}.` }]);
            const regenResp = await openai.chat.completions.create({
              model: modelName,
              messages: [
                { role: 'system', content: regenSys },
                { role: 'user', content: resumePrompt ? `Generate an opening question based on the candidate's resume and target position.` : `Generate a professional opening interview question for the role of ${jobTitle || 'Software Engineer'}.` }
              ],
              max_tokens: 120,
              temperature: Math.max(0.05, modeConfig.temperature - 0.3),
            });
            const regenText = regenResp.choices[0].message.content || '';
            logLLMPayload('initial-question - regen response', regenResp.choices[0].message ? [regenResp.choices[0].message] : []);
            const regenTrim = enforceQuestionOnly(clampWords(regenText, 200), 40);
            if (isValidQuestion(regenTrim)) {
              initialQuestion = regenTrim;
            } else {
              const fallback = jobTitle ? `What's your experience with the main technologies required for ${jobTitle}${company ? ` at ${company}` : ''}?` : 'Tell me about your technical background relevant to this role.';
              initialQuestion = enforceQuestionOnly(fallback, 40);
              console.warn('Using fallback initial question due to repeated validation failure');
            }
          }
        } catch (e) {
          console.warn('Initial question validation/regeneration failed:', e?.message || e);
        }

      // Hallucination detection for initial opening question
      try {
        const allowedContext = `${jobPrompt || ''} ${resumePrompt || ''} ${companyQuestionContext || ''}`;
        const rawInit = response.choices[0].message.content || '';
        const hallucinated = detectHallucinatedEntities(rawInit, allowedContext);
        if (hallucinated) {
          console.warn('🛑 Hallucinated entities detected in initial question:', hallucinated);
          try {
            const antiSys = systemPrompt + '\nDO NOT INVENT OR MENTION PROJECTS, COMPANIES, OR SYSTEMS NOT PRESENT IN THE PROVIDED CONTEXT. OUTPUT ONLY A SINGLE QUESTION.';
            const antiResp = await openai.chat.completions.create({
              model: modelName,
              messages: [
                { role: 'system', content: antiSys },
                { role: 'user', content: resumePrompt 
                    ? `Generate an opening question based on the candidate's resume and target position. Ask about specific projects or experience they've explicitly mentioned. Make it personalized and specific, not generic.`
                    : `Generate a professional opening interview question for the role of ${jobTitle || 'Software Engineer'}.` }
              ],
              max_tokens: 120,
              temperature: Math.max(0.1, modeConfig.temperature - 0.2)
            });

            const antiText = antiResp.choices[0].message.content || '';
            const antiTrim = enforceQuestionOnly(clampWords(antiText, 200), 40);
            const stillHall = detectHallucinatedEntities(antiText, allowedContext);
            if (antiTrim && antiTrim.trim().endsWith('?') && !stillHall) {
              initialQuestion = antiTrim;
            } else {
              const fallback = jobTitle ? `Describe your experience with the core skills needed for the ${jobTitle} position${company ? ` at ${company}` : ''}.` : 'What technical experience do you have that\'s relevant to this job?';
              initialQuestion = enforceQuestionOnly(fallback, 40);
            }
          } catch (e) {
            console.warn('Anti-hallucination regeneration (initial) failed:', e?.message || e);
          }
        }
      } catch (e) {
        console.warn('Initial-question hallucination detection failed:', e?.message || e);
      }

      console.log(`✅ Generated opening question with strict resume-based approach`);
    }

    const greeting = buildStarterGreeting({ jobTitle, company, mode });
    let opening = enforceQuestionOnly(clampWords(`${greeting}\n\n${initialQuestion}`, 200), 40);
    // Sanitize opening question before returning; if sanitized empty, use fallback
    opening = sanitizeText(opening);
    if (!opening || !opening.trim()) {
      console.warn('Initial question sanitized to empty — using fallback opening question');
      opening = 'Can you describe a specific project from your resume that best demonstrates your fit for this role?';
    }

    res.status(200).json({
      status: 'success',
      data: {
        question: opening,
        mode: mode,
        jobContext: { jobTitle, company },
        hasResumeContext: !!fullResumeText,
        hasCompanyQuestions: !!companyContext,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('OpenAI API error:', error?.message || error);
    if (error?.response) {
      console.error('LLM response status:', error.response.status);
      console.error('LLM response data:', error.response.data);
    }
    if (error?.stack) {
      console.error(error.stack);
    }
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate initial question',
      error: error.message
    });
  }
}));

// @desc    Generate comprehensive AI feedback for entire interview
// @route   POST /api/ai/generate-interview-feedback
// @access  Private
router.post('/generate-interview-feedback', authenticateToken, asyncHandler(async (req, res) => {
  const { conversation, mode, jobTitle, company, jobDescription, chatId } = req.body;

  console.log('📊 Feedback generation request received');
  console.log(`   Mode: ${mode}`);
  console.log(`   Conversation messages: ${conversation?.length || 0}`);
  console.log(`   Job: ${jobTitle}${company ? ` at ${company}` : ''}`);
  console.log(`   Chat ID: ${chatId}`);
  console.log(`   User plan: ${req.user?.plan || 'UNKNOWN'}`);

  const isStarterPlan = req.user?.plan === 'STARTER';

  if (!conversation || !Array.isArray(conversation) || conversation.length === 0) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid conversation data provided'
    });
  }

  try {
    // Use the globally initialized openai client
    const oaiClient = openai;

    // Format conversation for analysis
    const conversationText = conversation
      .map((msg, idx) => {
        const role = msg.type === 'user' ? 'Candidate' : 'Interviewer';
        return `${role}: ${msg.text}`;
      })
      .join('\n\n');

    // Build job context
    let jobContext = '';
    if (jobTitle || company || jobDescription) {
      jobContext = `\n\nJOB CONTEXT:\nPosition: ${jobTitle || 'Not specified'}${company ? ` at ${company}` : ''}`;
      if (jobDescription) {
        jobContext += `\nDescription: ${jobDescription}`;
      }
    }

    const systemPrompt = `You are an expert technical interviewer and career coach. Analyze the provided interview conversation and provide structured, honest, and constructive feedback.

Be critical but fair. Identify both strengths and areas for improvement. Focus on:
1. Communication clarity and articulation
2. Technical knowledge and depth
3. Problem-solving approach
4. Self-awareness and learning mindset
5. Enthusiasm and passion for the role
6. Professional maturity and judgment
7. Alignment with resume claims vs actual performance

Provide specific examples from the conversation to support your feedback.
Reference resume skills claimed vs demonstrated in the interview.
Compare their answers to expected competency levels for the role.`;

    console.log('🤖 Calling OpenAI API for feedback generation...');
    console.log(`   Conversation length: ${conversationText.length} characters`);

    logLLMRequest('interview feedback generation');

    const response = await oaiClient.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `${systemPrompt}${jobContext}\nKeep the entire JSON concise; keep text fields under 50 words each.`
        },
        {
          role: 'user',
          content: `Please analyze this ${mode || 'technical'} interview and provide structured feedback. Keep summaries concise (under 50 words per field) and do not add extra narration. Use this exact JSON format:
{
  "overallScore": <1-10>,
  "summary": "<1-2 sentence overall impression, under 50 words>",
  "strengths": [
    "<strength 1 with example, under 20 words>",
    "<strength 2 with example, under 20 words>",
    "<strength 3 with example, under 20 words>"
  ],
  "improvements": [
    "<area for improvement 1 with suggestion, under 20 words>",
    "<area for improvement 2 with suggestion, under 20 words>",
    "<area for improvement 3 with suggestion, under 20 words>"
  ],
  "tips": [
    "<concise actionable tip 1, under 20 words>",
    "<concise actionable tip 2, under 20 words>",
    "<concise actionable tip 3, under 20 words>",
    "<concise actionable tip 4, under 20 words>"
  ],
  "communication": {
    "score": <1-10>,
    "feedback": "<specific feedback on communication, under 30 words>"
  },
  "technicalKnowledge": {
    "score": <1-10>,
    "feedback": "<specific feedback on technical depth, under 30 words>"
  },
  "problemSolving": {
    "score": <1-10>,
    "feedback": "<specific feedback on approach and methodology, under 30 words>"
  },
  "professionalism": {
    "score": <1-10>,
    "feedback": "<specific feedback on professionalism, under 30 words>"
  },
  "recommendation": "<Concise recommendation, under 30 words>"
}

Conversation:
${conversationText}`
        }
      ],
      max_tokens: 400,
      temperature: 0.7,
    });

    console.log('✅ OpenAI API response received');

    let feedbackData;
    let savedToChat = false;
    try {
      const responseText = response.choices[0].message.content;
      console.log('📝 Raw response length:', responseText.length);
      
      // Extract JSON from response (in case it has extra text)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : responseText;
      
      feedbackData = JSON.parse(jsonStr);
      console.log('✅ Successfully parsed feedback JSON');
      console.log(`   Overall Score: ${feedbackData.overallScore}/10`);

      if (isStarterPlan) {
        const strengths = Array.isArray(feedbackData.strengths)
          ? feedbackData.strengths.slice(0, 2)
          : [];
        const improvements = Array.isArray(feedbackData.improvements)
          ? feedbackData.improvements.slice(0, 2)
          : [];

        feedbackData = {
          tier: 'basic',
          overallScore: feedbackData.overallScore ?? 0,
          summary: feedbackData.summary || 'Summary unavailable.',
          strengths,
          improvements,
          recommendation: feedbackData.recommendation || '',
          tips: []
        };
        console.log('ℹ️ Applied basic feedback template for Starter plan');
      } else {
        const tips = Array.isArray(feedbackData.tips)
          ? feedbackData.tips.slice(0, 4)
          : [];

        feedbackData = {
          ...feedbackData,
          tips,
          tier: 'full'
        };
      }

      // Save feedback to chat if chatId provided
      if (chatId) {
        try {
          console.log('💾 Saving feedback to chat database...');
          const updatedChat = await Chat.findOneAndUpdate(
            {
              _id: chatId,
              userId: req.user.id
            },
            {
              feedback: {
                overallScore: feedbackData.overallScore || 0,
                summary: feedbackData.summary || '',
                strengths: feedbackData.strengths || [],
                improvements: feedbackData.improvements || [],
                communication: feedbackData.communication || {},
                technicalKnowledge: feedbackData.technicalKnowledge || {},
                problemSolving: feedbackData.problemSolving || {},
                professionalism: feedbackData.professionalism || {},
                recommendation: feedbackData.recommendation || '',
                tips: feedbackData.tips || [],
                generatedAt: new Date()
              },
              status: 'completed',
              score: Math.round(feedbackData.overallScore * 10) // Convert to percentage
            },
            { new: true, runValidators: true }
          );

          if (updatedChat) {
            console.log('✅ Feedback saved to chat successfully');
            savedToChat = true;
          } else {
            console.warn('⚠️ Chat not found for update');
          }
        } catch (dbError) {
          console.warn('⚠️ Failed to save feedback to database:', dbError.message);
          // Don't throw - still return the feedback even if DB save fails
        }
      }

    } catch (parseError) {
      console.error('⚠️ Failed to parse feedback JSON:', parseError.message);
      console.log('Raw response:', response.choices[0].message.content);
      feedbackData = {
        rawFeedback: response.choices[0].message.content,
        parseError: true,
        errorMessage: parseError.message
      };
    }

    res.status(200).json({
      status: 'success',
      data: {
        feedback: feedbackData,
        mode: mode,
        jobContext: { jobTitle, company },
        savedToChat: savedToChat,
        chatId: chatId,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Interview feedback generation error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate interview feedback',
      error: error.message
    });
  }
}));

export default router;