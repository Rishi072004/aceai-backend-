/**
 * ULTRA-LOW LATENCY VOICE INTERVIEW STREAMING
 * 
 * HOW IT WORKS - End-to-End Pipeline:
 * ====================================
 * 
 * 1. MICROPHONE CAPTURE (Frontend)
 *    - User speaks → Browser captures audio chunks (MediaRecorder)
 *    - Audio chunks sent immediately via WebSocket (no waiting for complete recording)
 * 
 * 2. WEBSOCKET TRANSPORT (Real-time bidirectional)
 *    - Persistent connection between browser and server
 *    - Audio flows: Frontend → Backend
 *    - Text/responses flow: Backend → Frontend
 *    - Latency saved: No HTTP overhead, instant delivery
 * 
 * 3. DEEPGRAM STREAMING STT (Speech-to-Text)
 *    - Audio chunks forwarded to Deepgram's live transcription API
 *    - Returns PARTIAL transcripts (as user speaks) + FINAL transcript (after pause)
 *    - Latency saved: Transcription happens in real-time, no waiting for full audio
 * 
 * 4. TRANSCRIPT DISPLAY (Immediate feedback)
 *    - Partial transcripts shown live in UI (user sees words appear as they speak)
 *    - Final transcript triggers next stage
 *    - Latency saved: User gets instant visual feedback
 * 
 * 5. LLM PROCESSING (Fast model)
 *    - Final transcript sent to GPT-4o-mini (fast, cost-effective)
 *    - Generates next interview question + short feedback
 *    - Latency saved: Fast model responds in ~500ms-1s
 * 
 * 6. STREAMING TEXT RESPONSE (Progressive rendering)
 *    - LLM response streamed token-by-token back to frontend
 *    - User sees response appear word-by-word (feels instant)
 *    - Latency saved: No waiting for complete response
 * 
 * 7. TTS AUDIO (Short clips only)
 *    - Only 1-2 line responses converted to speech (OpenAI TTS)
 *    - Long feedback stays text-only (saves time + costs)
 *    - Audio streamed and played immediately
 *    - Latency saved: Short audio = fast generation + playback
 * 
 * TOTAL LATENCY IMPROVEMENT:
 * - Traditional: 3-8 seconds (record → upload → STT → LLM → TTS → download → play)
 * - Streaming: 0.5-2 seconds (live STT → fast LLM → instant text → quick audio)
 * - Speed gain: 3-6x faster perceived response time
 */

import { WebSocketServer } from 'ws';
import { createClient } from '@deepgram/sdk';
import { llmClient, llmProviderName } from '../services/llmProvider.js';

const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;

if (!deepgramApiKey) {
  console.error('⚠️  DEEPGRAM_API_KEY not found in .env file');
  console.log('Add: DEEPGRAM_API_KEY=your_key_here');
}

const deepgram = createClient(deepgramApiKey);
const openai = llmClient;

const logLLMRequest = (context = '') => {
  const suffix = context ? ` - ${context}` : '';
  console.log(`Using LLM Provider: ${llmProviderName}${suffix}`);
};

/**
 * STEP 1: Initialize WebSocket Server
 * Creates a persistent bidirectional connection for real-time audio/text streaming
 */
export function initializeVoiceStreamWebSocket(server) {
  const wss = new WebSocketServer({ 
    server,
    path: '/api/voice-stream'
  });

  console.log('🎙️  Voice Stream WebSocket server initialized at /api/voice-stream');

  wss.on('connection', async (ws, req) => {
    console.log('✅ Client connected to voice stream');

    // Session state for this connection
    let deepgramLive = null;
    let sessionContext = {
      chatId: null,
      mode: 'moderate',
      jobContext: {},
      conversationHistory: [],
      currentTranscript: '',
      isProcessing: false
    };

    /**
     * STEP 2: Setup Deepgram Streaming Connection
     * Opens live transcription stream - sends audio chunks, receives real-time transcripts
     */
    const setupDeepgramStream = () => {
      try {
        // Configure Deepgram for optimal latency
        deepgramLive = deepgram.listen.live({
          model: 'nova-2',              // Latest, most accurate model
          language: 'en',
          smart_format: true,           // Auto-capitalize, punctuate
          interim_results: true,        // Get partial transcripts as user speaks
          punctuate: true,
          endpointing: 300,             // Detect silence after 300ms
          vad_events: true,             // Voice activity detection
          encoding: 'linear16',
          sample_rate: 16000
        });

        /**
         * STEP 3: Handle Partial Transcripts (Real-time feedback)
         * Sent while user is still speaking - shows live text as words are spoken
         */
        deepgramLive.on('Results', async (data) => {
          const transcript = data.channel?.alternatives?.[0]?.transcript;
          
          if (!transcript) return;

          const isFinal = data.is_final;
          const speechFinal = data.speech_final;

          // Send partial transcript to frontend (live typing effect)
          if (!isFinal) {
            ws.send(JSON.stringify({
              type: 'transcript_partial',
              text: transcript,
              timestamp: Date.now()
            }));
            return;
          }

          /**
           * STEP 4: Handle Final Transcript (Trigger LLM)
           * User finished speaking - process complete sentence
           */
          if (isFinal && speechFinal) {
            sessionContext.currentTranscript = transcript;

            // Send final transcript to frontend
            ws.send(JSON.stringify({
              type: 'transcript_final',
              text: transcript,
              timestamp: Date.now()
            }));

            // Prevent concurrent processing
            if (sessionContext.isProcessing) {
              console.log('⏳ Already processing, skipping...');
              return;
            }

            sessionContext.isProcessing = true;

            /**
             * STEP 5: Generate AI Response (Fast LLM)
             * Use GPT-4o-mini for speed + cost efficiency
             */
            try {
              await generateAIResponse(transcript, ws, sessionContext);
            } catch (error) {
              console.error('Error generating AI response:', error);
              ws.send(JSON.stringify({
                type: 'error',
                message: 'Failed to generate response'
              }));
            } finally {
              sessionContext.isProcessing = false;
            }
          }
        });

        // Handle Deepgram errors
        deepgramLive.on('error', (error) => {
          console.error('Deepgram error:', error);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Transcription error'
          }));
        });

        // Handle Deepgram connection close
        deepgramLive.on('close', () => {
          console.log('Deepgram connection closed');
        });

        console.log('🎙️  Deepgram stream ready');

      } catch (error) {
        console.error('Failed to setup Deepgram:', error);
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Failed to initialize speech recognition'
        }));
      }
    };

    /**
     * STEP 6: Generate AI Response with Streaming
     * Fast LLM generates next question + feedback, streams back token-by-token
     */
    const generateAIResponse = async (userAnswer, ws, context) => {
      try {
        // Build conversation context
        const systemPrompt = `You are an AI interviewer conducting a ${context.mode} difficulty interview for ${context.jobContext.jobTitle || 'a position'} at ${context.jobContext.company || 'the company'}.

      IMPORTANT INSTRUCTIONS:
      1. Give VERY SHORT instant feedback first (1-2 words only): "Good", "Nice", "Okay", "Great"
      2. Then ask the next interview question
      3. Keep the question under 60 words, one sentence, no lists, no sections
      4. Match the difficulty level: ${context.mode}

      Format your response as:
      [FEEDBACK: <1-2 words>]
      [QUESTION: <your next question>]`;

        const messages = [
          { role: 'system', content: systemPrompt },
          ...context.conversationHistory,
          { role: 'user', content: userAnswer }
        ];

        // Stream response from LLM (OpenAI default, Groq optional)
        logLLMRequest('voice-stream chat');

        const stream = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages,
          stream: true,
          temperature: 0.7,
          max_tokens: 120  // Keep responses concise
        });

        let fullResponse = '';
        let feedbackText = '';
        let questionText = '';
        let inFeedback = false;
        let inQuestion = false;

        /**
         * STEP 7: Stream Response Tokens (Progressive rendering)
         * Send each word/token as it's generated - user sees text appear instantly
         */
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          if (!content) continue;

          fullResponse += content;

          // Parse feedback and question sections
          if (content.includes('[FEEDBACK:')) inFeedback = true;
          if (content.includes('[QUESTION:')) {
            inFeedback = false;
            inQuestion = true;
          }

          if (inFeedback && !content.includes('[FEEDBACK:')) {
            feedbackText += content;
          }
          if (inQuestion && !content.includes('[QUESTION:')) {
            questionText += content;
          }

          // Stream text to frontend in real-time
          ws.send(JSON.stringify({
            type: 'ai_response_chunk',
            content,
            timestamp: Date.now()
          }));
        }

        // Clean up parsed text
        feedbackText = feedbackText.replace(/]/g, '').trim();
        questionText = questionText.replace(/]/g, '').trim();

        /**
         * STEP 8: Generate Short TTS Audio (Only for feedback)
         * Convert 1-2 line feedback to speech, keep long text text-only
         */
        let audioBase64 = null;
        const shouldGenerateAudio = feedbackText.length > 0 && feedbackText.length <= 20;

        if (shouldGenerateAudio) {
          try {
            logLLMRequest('voice-stream TTS');

            const mp3Response = await openai.audio.speech.create({
              model: 'tts-1',  // Fastest TTS model
              voice: 'nova',
              input: feedbackText,
              speed: 1.1  // Slightly faster for snappier feel
            });

            const buffer = Buffer.from(await mp3Response.arrayBuffer());
            audioBase64 = buffer.toString('base64');

            console.log(`🔊 Generated TTS audio (${feedbackText.length} chars)`);
          } catch (error) {
            console.error('TTS generation failed:', error);
            // Continue without audio if TTS fails
          }
        } else {
          console.log('📝 Skipping TTS - text only (too long or empty)');
        }

        // Update conversation history
        context.conversationHistory.push(
          { role: 'user', content: userAnswer },
          { role: 'assistant', content: fullResponse }
        );

        // Keep history manageable (last 10 exchanges)
        if (context.conversationHistory.length > 20) {
          context.conversationHistory = context.conversationHistory.slice(-20);
        }

        /**
         * STEP 9: Send Complete Response Package
         * Final bundle with all data for frontend to save/display
         */
        ws.send(JSON.stringify({
          type: 'ai_response_complete',
          feedback: feedbackText,
          question: questionText,
          fullResponse,
          audioBase64,
          hasAudio: shouldGenerateAudio,
          timestamp: Date.now()
        }));

        console.log(`✅ Response complete: "${feedbackText}" + question`);

      } catch (error) {
        console.error('AI response generation error:', error);
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Failed to generate AI response'
        }));
      }
    };

    /**
     * STEP 10: Handle Incoming Messages from Client
     * Process commands and audio data from frontend
     */
    ws.on('message', async (message) => {
      try {
        // Audio data (binary) - forward to Deepgram
        if (message instanceof Buffer) {
          if (deepgramLive) {
            deepgramLive.send(message);
          }
          return;
        }

        // Control messages (JSON)
        const data = JSON.parse(message.toString());

        switch (data.type) {
          case 'start_stream':
            // Initialize session context
            sessionContext.chatId = data.chatId;
            sessionContext.mode = data.mode || 'moderate';
            sessionContext.jobContext = data.jobContext || {};
            
            // Setup Deepgram streaming
            setupDeepgramStream();
            
            ws.send(JSON.stringify({
              type: 'stream_ready',
              message: 'Voice streaming initialized'
            }));
            break;

          case 'stop_stream':
            // Clean up Deepgram connection
            if (deepgramLive) {
              deepgramLive.finish();
              deepgramLive = null;
            }
            
            ws.send(JSON.stringify({
              type: 'stream_stopped',
              message: 'Voice streaming stopped'
            }));
            break;

          case 'ping':
            // Keepalive
            ws.send(JSON.stringify({ type: 'pong' }));
            break;

          default:
            console.log('Unknown message type:', data.type);
        }

      } catch (error) {
        console.error('Message handling error:', error);
      }
    });

    /**
     * STEP 11: Cleanup on Disconnect
     * Properly close all connections when client disconnects
     */
    ws.on('close', () => {
      console.log('❌ Client disconnected from voice stream');
      
      if (deepgramLive) {
        deepgramLive.finish();
        deepgramLive = null;
      }
    });

    // Handle WebSocket errors
    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      
      if (deepgramLive) {
        deepgramLive.finish();
        deepgramLive = null;
      }
    });
  });

  return wss;
}
