/**
 * DIAGNOSTIC TOOL - Check Voice Streaming Setup
 * Run this to verify your environment is ready
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '.env') });

console.log('\n🔍 VOICE STREAMING DIAGNOSTIC TOOL\n');
console.log('=' .repeat(50));

let hasErrors = false;

// Check Node version
const nodeVersion = process.version;
const majorVersion = parseInt(nodeVersion.split('.')[0].substring(1));
console.log(`\n📦 Node.js Version: ${nodeVersion}`);
if (majorVersion < 16) {
  console.error('   ❌ ERROR: Node.js 16+ required');
  hasErrors = true;
} else {
  console.log('   ✅ OK');
}

// Check environment variables
console.log('\n🔑 Environment Variables:');

const requiredVars = {
  'DEEPGRAM_API_KEY': process.env.DEEPGRAM_API_KEY,
  'OPENAI_API_KEY': process.env.OPENAI_API_KEY,
  'PORT': process.env.PORT || '5000',
  'MONGODB_URI': process.env.MONGODB_URI
};

for (const [key, value] of Object.entries(requiredVars)) {
  if (!value || value === 'undefined') {
    console.log(`   ❌ ${key}: MISSING`);
    hasErrors = true;
  } else {
    const masked = value.substring(0, 8) + '***' + value.slice(-4);
    console.log(`   ✅ ${key}: ${masked}`);
  }
}

// Check dependencies
console.log('\n📚 Critical Dependencies:');

const checkPackage = async (packageName) => {
  try {
    await import(packageName);
    console.log(`   ✅ ${packageName}`);
    return true;
  } catch (error) {
    console.log(`   ❌ ${packageName}: NOT INSTALLED`);
    hasErrors = true;
    return false;
  }
};

await checkPackage('@deepgram/sdk');
await checkPackage('ws');
await checkPackage('openai');
await checkPackage('express');

// Test Deepgram connection
console.log('\n🎙️  Testing Deepgram Connection:');
try {
  const { createClient } = await import('@deepgram/sdk');
  const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
  
  // Test with a simple API call
  console.log('   📡 Connecting to Deepgram...');
  const response = await deepgram.listen.prerecorded.transcribeUrl({
    url: 'https://dpgr.am/spacewalk.wav'
  });
  
  if (response.result) {
    console.log('   ✅ Deepgram API Key is VALID');
  }
} catch (error) {
  console.log('   ❌ Deepgram connection failed:', error.message);
  console.log('   ⚠️  Check your DEEPGRAM_API_KEY');
  hasErrors = true;
}

// Test OpenAI connection
console.log('\n🤖 Testing OpenAI Connection:');
try {
  const OpenAI = (await import('openai')).default;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  
  console.log('   📡 Connecting to OpenAI...');
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Say "OK"' }],
    max_tokens: 5
  });
  
  if (response.choices && response.choices.length > 0) {
    console.log('   ✅ OpenAI API Key is VALID');
  }
} catch (error) {
  console.log('   ❌ OpenAI connection failed:', error.message);
  console.log('   ⚠️  Check your OPENAI_API_KEY');
  hasErrors = true;
}

// Check port availability
console.log('\n🔌 Port Availability:');
try {
  const net = await import('net');
  const server = net.createServer();
  
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`   ⚠️  Port ${process.env.PORT || 5000} is already in use`);
        console.log('   ℹ️  Stop the existing process or change PORT in .env');
      } else {
        reject(err);
      }
      resolve();
    });
    
    server.once('listening', () => {
      console.log(`   ✅ Port ${process.env.PORT || 5000} is available`);
      server.close();
      resolve();
    });
    
    server.listen(parseInt(process.env.PORT) || 5000);
  });
} catch (error) {
  console.log('   ❌ Port check failed:', error.message);
}

// Final summary
console.log('\n' + '='.repeat(50));
if (hasErrors) {
  console.log('\n❌ SETUP INCOMPLETE - Fix the errors above');
  console.log('\n📖 See VOICE_STREAMING_TROUBLESHOOTING.md for help\n');
  process.exit(1);
} else {
  console.log('\n✅ ALL CHECKS PASSED - Ready to start!');
  console.log('\n🚀 Run: npm run dev');
  console.log('🧪 Test: node test-websocket.js\n');
}
