import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createRequire } from 'module';
import mammoth from 'mammoth';
import { llmClient, llmProviderName } from '../services/llmProvider.js';


// pdf-parse is a CommonJS module, need to import it differently
const require = createRequire(import.meta.url);
const pdfParseModule = require('pdf-parse');
// pdf-parse exports a default function
const pdfParse = pdfParseModule.default || pdfParseModule;
import { authenticateToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import Resume from '../models/Resume.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();

// LLM client (OpenAI by default, Groq optional)
const openai = llmClient;

const logLLMRequest = (context = '') => {
  const suffix = context ? ` - ${context}` : '';
  console.log(`Using LLM Provider: ${llmProviderName}${suffix}`);
};

// Configure multer for file upload
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Support PDF and DOCX; block legacy DOC to avoid parser failures
    const allowedTypes = ['.pdf', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF or DOCX files are allowed'));
    }
  }
});

// Helper function to parse PDF
async function parsePDF(buffer) {
  try {
    console.log('Attempting PDF parse with buffer size:', buffer.length);
    const data = await pdfParse(buffer);
    console.log('PDF parse successful, extracted text length:', data.text?.length || 0);
    if (!data.text) {
      throw new Error('PDF parser returned empty text');
    }
    return data.text;
  } catch (error) {
    console.error('PDF parsing error:', error.message);
    throw new Error(`Failed to parse PDF: ${error.message}`);
  }
}

// Helper function to parse DOCX
async function parseDOCX(buffer) {
  try {
    console.log('Attempting DOCX parse with buffer size:', buffer.length);
    const result = await mammoth.extractRawText({ buffer });
    console.log('DOCX parse successful, extracted text length:', result.value?.length || 0);
    if (!result.value) {
      throw new Error('DOCX parser returned empty text');
    }
    return result.value;
  } catch (error) {
    console.error('DOCX parsing error:', error.message);
    throw new Error(`Failed to parse DOCX: ${error.message}`);
  }
}

// Helper function to extract basic information from resume text
function extractBasicInfo(text) {
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
  const phoneRegex = /(\+\d{1,3}[-.]?)?\(?\d{3}\)?[-.]?\d{3}[-.]?\d{4}/;
  
  const email = text.match(emailRegex)?.[0] || '';
  const phone = text.match(phoneRegex)?.[0] || '';
  
  // Extract skills (common technical keywords)
  const skillKeywords = [
    'JavaScript', 'Python', 'Java', 'C++', 'C#', 'Ruby', 'PHP', 'Swift', 'Kotlin',
    'React', 'Angular', 'Vue', 'Node.js', 'Express', 'Django', 'Flask', 'Spring',
    'SQL', 'MongoDB', 'PostgreSQL', 'MySQL', 'Redis', 'AWS', 'Azure', 'GCP',
    'Docker', 'Kubernetes', 'Git', 'CI/CD', 'Agile', 'Scrum', 'REST', 'GraphQL',
    'HTML', 'CSS', 'TypeScript', 'Machine Learning', 'AI', 'Data Science',
    'Leadership', 'Communication', 'Problem Solving', 'Team Management'
  ];
  
  const skills = skillKeywords.filter(skill => 
    new RegExp(`\\b${skill}\\b`, 'i').test(text)
  );
  
  return {
    email,
    phone,
    skills: [...new Set(skills)] // Remove duplicates
  };
}

// Helper function to analyze resume with AI - STRICT EXTRACTION
async function analyzeResumeWithAI(resumeText) {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    console.warn('OpenAI API key not configured - skipping AI analysis');
    return {
      yearsOfExperience: 0,
      primaryRole: 'Not determined',
      technicalSkills: [],
      softSkills: [],
      industries: [],
      strengths: [],
      areasForImprovement: [],
      suggestedInterviewTopics: [],
      structuredExperience: [],
      projects: [],
      education: [],
      achievements: []
    };
  }

  try {
    console.log('🤖 Calling OpenAI API for resume analysis...');
    logLLMRequest('resume analysis');
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an expert resume analyzer. Extract ONLY information that is EXPLICITLY stated in the resume.
DO NOT infer, assume, or add information that is not clearly mentioned.

Your response must be ONLY a valid JSON object with this exact structure (no markdown, no extra text):
{
  "yearsOfExperience": <number - calculate from actual dates in resume, default 0 if not found>,
  "primaryRole": "<most recent job title or main profession>",
  "technicalSkills": ["skills explicitly listed in resume"],
  "softSkills": ["soft skills explicitly mentioned"],
  "industries": ["industries or sectors mentioned"],
  "strengths": ["key strengths based on achievements"],
  "areasForImprovement": [],
  "suggestedInterviewTopics": ["topics based on actual experience"],
  "structuredExperience": [
    {
      "company": "<company name>",
      "jobTitle": "<exact job title>",
      "duration": "<from-to or years>",
      "keyResponsibilities": ["responsibilities from resume"],
      "technologiesUsed": ["technologies mentioned"],
      "achievements": ["specific achievements"]
    }
  ],
  "projects": [
    {
      "name": "<project name>",
      "description": "<description>",
      "technologies": ["technologies used"],
      "yourRole": "<your role>",
      "outcome": "<outcome>"
    }
  ],
  "education": [
    {
      "school": "<school name>",
      "degree": "<degree type>",
      "field": "<field of study>",
      "graduationYear": "<year>"
    }
  ],
  "achievements": ["awards, certifications, publications"]
}

CRITICAL:
- Extract ALL work experiences listed
- Extract ALL projects/accomplishments  
- Extract ALL education entries
- Calculate years of experience from dates
- Identify the primary role from most recent position
- Return EMPTY arrays if no data found, never null
- Return valid JSON ONLY, nothing else`
        },
        {
          role: 'user',
          content: `Analyze this resume and extract ALL information. Return ONLY valid JSON:\n\n${resumeText.substring(0, 8000)}`
        }
      ],
      max_tokens: 3000,
      temperature: 0.3,
    });

    const analysisText = response.choices[0].message.content.trim();
    
    console.log('📝 Raw AI Analysis Response (first 300 chars):');
    console.log(analysisText.substring(0, 300));
    
    // Try to extract JSON from response
    let analysis;
    try {
      // First try direct parsing
      analysis = JSON.parse(analysisText);
    } catch (e) {
      console.warn('Direct JSON parse failed, trying to extract JSON from response...');
      // Try to extract JSON object from response
      const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    }
    
    // Validate and sanitize the analysis object
    const sanitizedAnalysis = {
      yearsOfExperience: Number(analysis.yearsOfExperience) || 0,
      primaryRole: String(analysis.primaryRole || 'Not determined'),
      technicalSkills: Array.isArray(analysis.technicalSkills) ? analysis.technicalSkills : [],
      softSkills: Array.isArray(analysis.softSkills) ? analysis.softSkills : [],
      industries: Array.isArray(analysis.industries) ? analysis.industries : [],
      strengths: Array.isArray(analysis.strengths) ? analysis.strengths : [],
      areasForImprovement: Array.isArray(analysis.areasForImprovement) ? analysis.areasForImprovement : [],
      suggestedInterviewTopics: Array.isArray(analysis.suggestedInterviewTopics) ? analysis.suggestedInterviewTopics : [],
      structuredExperience: Array.isArray(analysis.structuredExperience) ? analysis.structuredExperience.filter(e => e && typeof e === 'object') : [],
      projects: Array.isArray(analysis.projects) ? analysis.projects.filter(p => p && typeof p === 'object') : [],
      education: Array.isArray(analysis.education) ? analysis.education.filter(e => e && typeof e === 'object') : [],
      achievements: Array.isArray(analysis.achievements) ? analysis.achievements : []
    };
    
    console.log('✅ AI Analysis parsed successfully');
    console.log('   - Primary Role:', sanitizedAnalysis.primaryRole);
    console.log('   - Years of Experience:', sanitizedAnalysis.yearsOfExperience);
    console.log('   - Technical Skills:', sanitizedAnalysis.technicalSkills.length);
    console.log('   - Projects:', sanitizedAnalysis.projects.length);
    console.log('   - Work Experience:', sanitizedAnalysis.structuredExperience.length);
    console.log('   - Education:', sanitizedAnalysis.education.length);
    
    return sanitizedAnalysis;
  } catch (error) {
    console.error('❌ AI analysis error:', error.message);
    return {
      yearsOfExperience: 0,
      primaryRole: 'Not determined',
      technicalSkills: [],
      softSkills: [],
      industries: [],
      strengths: [],
      areasForImprovement: [],
      suggestedInterviewTopics: [],
      structuredExperience: [],
      projects: [],
      education: [],
      achievements: []
    };
  }
}

// @desc    Upload and parse resume
// @route   POST /api/resumes/upload
// @access  Private
router.post('/upload', authenticateToken, upload.single('resume'), asyncHandler(async (req, res) => {
  console.log('=== RESUME UPLOAD REQUEST ===');
  console.log('User ID:', req.user?._id);
  console.log('File received:', req.file ? 'Yes' : 'No');
  
  if (!req.file) {
    console.error('No file in request');
    return res.status(400).json({
      status: 'error',
      message: 'No file uploaded'
    });
  }

  console.log('File details:', {
    originalname: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype
  });

  try {
    const fileExtension = path.extname(req.file.originalname).toLowerCase();
    console.log('File extension:', fileExtension);

    // Parse resume based on file type with error handling
    let resumeText = '';
    let parsingFailed = false;
    
    try {
      if (fileExtension === '.pdf') {
        console.log('Parsing PDF file...');
        resumeText = await parsePDF(req.file.buffer);
      } else if (fileExtension === '.docx') {
        console.log('Parsing DOCX file...');
        resumeText = await parseDOCX(req.file.buffer);
      } else {
        throw new Error('Unsupported file format');
      }
      
      if (!resumeText || resumeText.trim().length === 0) {
        console.warn('⚠️  No text extracted, will use placeholder');
        parsingFailed = true;
        resumeText = `Resume file uploaded: ${req.file.originalname}. Content will be analyzed during interview.`;
      } else {
        console.log('✅ Resume text extracted, length:', resumeText.length);
      }
    } catch (parseError) {
      console.error('⚠️  Parsing error (non-fatal):', parseError.message);
      parsingFailed = true;
      resumeText = `Resume file uploaded: ${req.file.originalname}. Content will be analyzed during interview.`;
    }
    
    // Guardrail: warn if text is very short, but don't block upload; advise better file
    const MIN_TEXT_LENGTH = 120;
    const textLength = (resumeText || '').trim().length;
    const shortText = textLength < MIN_TEXT_LENGTH;
    if (shortText) {
      console.warn('⚠️  Resume text appears very short; extraction quality may be poor:', textLength);
    }

    // Extract basic information
    let basicInfo = { email: '', phone: '', skills: [] };
    if (!parsingFailed) {
      try {
        console.log('Extracting basic information...');
        basicInfo = extractBasicInfo(resumeText);
        console.log('Basic info extracted:', {
          email: basicInfo.email ? 'Found' : 'Not found',
          phone: basicInfo.phone ? 'Found' : 'Not found',
          skillsCount: basicInfo.skills.length
        });
      } catch (infoError) {
        console.warn('⚠️  Basic info extraction failed:', infoError.message);
      }
    }
    
    // Analyze with AI (with fallback)
    let aiAnalysis = {
      yearsOfExperience: 0,
      primaryRole: 'Not determined',
      technicalSkills: [],
      softSkills: [],
      industries: [],
      strengths: [],
      areasForImprovement: [],
      suggestedInterviewTopics: [],
      structuredExperience: [],
      projects: [],
      education: [],
      achievements: []
    };
    
    if (!parsingFailed) {
      try {
        console.log('Starting AI analysis with strict extraction...');
        aiAnalysis = await analyzeResumeWithAI(resumeText);
        console.log('✅ AI analysis complete:', {
          primaryRole: aiAnalysis.primaryRole,
          yearsOfExperience: aiAnalysis.yearsOfExperience,
          technicalSkillsCount: aiAnalysis.technicalSkills?.length || 0,
          projectsCount: aiAnalysis.projects?.length || 0,
          structuredExperienceCount: aiAnalysis.structuredExperience?.length || 0
        });
      } catch (aiError) {
        console.warn('⚠️  AI analysis failed (non-fatal):', aiError.message);
      }
    }
    
    // Create resume document (always succeeds)
    const resume = new Resume({
      userId: req.user._id,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      fileType: fileExtension.substring(1),
      rawText: resumeText, // Full resume text or placeholder
      parsedData: {
        email: basicInfo.email,
        phone: basicInfo.phone,
        skills: basicInfo.skills
      },
      analysis: {
        yearsOfExperience: aiAnalysis.yearsOfExperience || 0,
        primaryRole: aiAnalysis.primaryRole || 'Not determined',
        technicalSkills: aiAnalysis.technicalSkills || [],
        softSkills: aiAnalysis.softSkills || [],
        industries: aiAnalysis.industries || [],
        strengths: aiAnalysis.strengths || [],
        areasForImprovement: aiAnalysis.areasForImprovement || [],
        suggestedInterviewTopics: aiAnalysis.suggestedInterviewTopics || [],
        // NEW: Store structured extracted data
        structuredExperience: aiAnalysis.structuredExperience || [],
        projects: aiAnalysis.projects || [],
        education: aiAnalysis.education || [],
        achievements: aiAnalysis.achievements || []
      }
    });

    console.log('Saving resume to database...');
    await resume.save();
    console.log('✅ Resume saved successfully. ID:', resume._id);
    console.log('📊 Saved Data Summary:');
    console.log('   - Raw Text Length:', resume.rawText?.length || 0);
    console.log('   - Technical Skills:', resume.analysis?.technicalSkills?.length || 0);
    console.log('   - Projects:', resume.analysis?.projects?.length || 0);
    console.log('   - Work Experience:', resume.analysis?.structuredExperience?.length || 0);
    console.log('   - Education:', resume.analysis?.education?.length || 0);
    
    // IMPORTANT: Log if structured data is empty
    if ((resume.analysis?.projects?.length === 0 || !resume.analysis?.projects) && 
        (resume.analysis?.structuredExperience?.length === 0 || !resume.analysis?.structuredExperience)) {
      console.warn('⚠️  WARNING: Resume saved but NO structured experience or projects extracted!');
      console.warn('   This means the AI analysis may have failed to extract detailed information');
      console.warn('   Resume will still work with raw text for interviews');
    }


    res.status(201).json({
      status: 'success',
      data: {
        resume: {
          id: resume._id,
          fileName: resume.fileName,
          fileSize: resume.fileSizeFormatted,
          uploadedAt: resume.createdAt,
          parsedData: resume.parsedData,
          analysis: resume.analysis,
          parsingStatus: parsingFailed ? 'partial' : (shortText ? 'partial-short-text' : 'complete')
        }
      },
      message: parsingFailed
        ? 'Resume uploaded but parsing was incomplete. Interview will still work!'
        : shortText
          ? 'Resume uploaded but text was very short; try a text-based PDF/DOCX for better extraction.'
          : 'Resume analyzed successfully!'
    });
  } catch (error) {
    console.error('=== RESUME UPLOAD ERROR ===');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      status: 'error',
      message: 'Failed to process resume',
      error: error.message,
      details: error.stack
    });
  }
}));

// @desc    Get user's resumes
// @route   GET /api/resumes
// @access  Private
router.get('/', authenticateToken, asyncHandler(async (req, res) => {
  const resumes = await Resume.findActiveByUser(req.user._id);

  res.status(200).json({
    status: 'success',
    data: {
      resumes: resumes.map(resume => resume.getSummary())
    }
  });
}));

// @desc    Get specific resume details
// @route   GET /api/resumes/:id
// @access  Private
router.get('/:id', authenticateToken, asyncHandler(async (req, res) => {
  const resume = await Resume.findOne({
    _id: req.params.id,
    userId: req.user._id
  });

  if (!resume) {
    return res.status(404).json({
      status: 'error',
      message: 'Resume not found'
    });
  }

  res.status(200).json({
    status: 'success',
    data: {
      resume: {
        id: resume._id,
        fileName: resume.fileName,
        fileSize: resume.fileSizeFormatted,
        uploadedAt: resume.createdAt,
        parsedData: resume.parsedData,
        analysis: resume.analysis
      }
    }
  });
}));

// @desc    Delete resume
// @route   DELETE /api/resumes/:id
// @access  Private
router.delete('/:id', authenticateToken, asyncHandler(async (req, res) => {
  const resume = await Resume.findOne({
    _id: req.params.id,
    userId: req.user._id
  });

  if (!resume) {
    return res.status(404).json({
      status: 'error',
      message: 'Resume not found'
    });
  }

  resume.isActive = false;
  await resume.save();

  res.status(200).json({
    status: 'success',
    message: 'Resume deleted successfully'
  });
}));

// @desc    Generate resume-based interview questions
// @route   POST /api/resumes/:id/generate-questions
// @access  Private
router.post('/:id/generate-questions', authenticateToken, asyncHandler(async (req, res) => {
  const resume = await Resume.findOne({
    _id: req.params.id,
    userId: req.user._id
  });

  if (!resume) {
    return res.status(404).json({
      status: 'error',
      message: 'Resume not found'
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    return res.status(500).json({
      status: 'error',
      message: 'OpenAI API key not configured'
    });
  }

  try {
    // Update last used timestamp
    resume.lastUsed = new Date();
    await resume.save();

    logLLMRequest('resume-based questions');

    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: `You are an experienced technical interviewer. Based on the candidate's resume, generate 5 tailored interview questions that:
1. Test their claimed technical skills
2. Explore their work experience
3. Assess problem-solving abilities
4. Evaluate their knowledge depth in their domain
5. Challenge them appropriately for their experience level

Format your response as a JSON array of objects, each with "question" and "focus_area" fields.`
        },
        {
          role: 'user',
          content: `Generate interview questions for this candidate:

Role: ${resume.analysis.primaryRole}
Experience: ${resume.analysis.yearsOfExperience} years
Technical Skills: ${resume.analysis.technicalSkills.join(', ')}
Industries: ${resume.analysis.industries.join(', ')}
Key Strengths: ${resume.analysis.strengths.join(', ')}

Resume Summary:
${resume.rawText.substring(0, 2000)}`
        }
      ],
      max_tokens: 800,
      temperature: 0.7,
    });

    const questionsText = response.choices[0].message.content;
    
    let questions;
    try {
      questions = JSON.parse(questionsText);
    } catch {
      // If not JSON, parse as text
      questions = [{ question: questionsText, focus_area: 'General' }];
    }

    res.status(200).json({
      status: 'success',
      data: {
        questions,
        resumeAnalysis: {
          primaryRole: resume.analysis.primaryRole,
          yearsOfExperience: resume.analysis.yearsOfExperience,
          suggestedTopics: resume.analysis.suggestedInterviewTopics
        }
      }
    });
  } catch (error) {
    console.error('Question generation error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate questions',
      error: error.message
    });
  }
}));

export default router;

