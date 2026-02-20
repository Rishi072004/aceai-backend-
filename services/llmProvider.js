import OpenAI from 'openai';
import Groq from 'groq-sdk';

// Determine provider from environment; default to OpenAI for production safety
const providerEnv = (process.env.AI_PROVIDER || 'openai').toLowerCase();
const provider = providerEnv === 'groq' ? 'groq' : 'openai';

// Initialize OpenAI client (always available/fallback)
const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Initialize Groq client lazily to avoid throwing when key is missing
const groqApiKey = process.env.GROQ_API_KEY;
const groqBaseUrl = process.env.GROQ_BASE_URL || 'https://api.groq.com';
const groqClient = groqApiKey ? new Groq({ apiKey: groqApiKey, baseURL: groqBaseUrl }) : null;

// Map Groq responses to the OpenAI-compatible shape
const createGroqAdapter = () => {
  if (!groqClient) {
    console.warn('⚠️  Groq provider selected but GROQ_API_KEY is missing. Falling back to OpenAI.');
    return openaiClient;
  }
    const mapModelToGroq = (model) => {
      // Default to known-good Groq chat model
      const fallback = 'llama-3.3-70b-versatile';
      if (!model) return fallback;

      const normalized = model.toLowerCase();
      const mapping = {
        'gpt-4o-mini': 'llama-3.1-8b-instant',
        'gpt-4o': 'llama-3.3-70b-versatile',
        'gpt-4': 'llama-3.3-70b-versatile',
        'gpt-3.5-turbo': 'mixtral-8x7b-32768',
        'gpt-3.5-turbo-0125': 'mixtral-8x7b-32768'
      };

      return mapping[normalized] || fallback;
    };

  // Adapter maintains the same surface as the OpenAI client that the rest of the app expects
  return {
    chat: {
      completions: {
        create: async (payload) => {
          const mappedPayload = { ...payload };
          // Provide a sensible default Groq model if caller does not specify one
            mappedPayload.model = mapModelToGroq(mappedPayload.model);
          return groqClient.chat.completions.create(mappedPayload);
        }
      }
    },
    // Audio operations continue to use OpenAI to preserve existing behavior.
    // Deepgram remains the dedicated STT/TTS provider elsewhere in the stack.
    audio: {
      speech: {
        create: (...args) => openaiClient.audio.speech.create(...args)
      },
      transcriptions: {
        create: (...args) => openaiClient.audio.transcriptions.create(...args)
      }
    }
  };
};

const llmClient = provider === 'groq' ? createGroqAdapter() : openaiClient;
const llmProviderName = provider === 'groq' && groqClient ? 'Groq' : 'OpenAI';

const didFallbackToOpenAI = provider === 'groq' && !groqClient;

export const logProviderStatus = () => {
  console.log(`Using LLM Provider: ${llmProviderName}`);
  console.log('Using STT Provider: Deepgram');
  console.log('Using TTS Provider: Deepgram');

  if (didFallbackToOpenAI && provider === 'groq') {
    console.warn('⚠️  AI_PROVIDER is set to "groq" but GROQ_API_KEY is missing. Fallback to OpenAI is active.');
  }
};

export { llmClient, llmProviderName, openaiClient };
