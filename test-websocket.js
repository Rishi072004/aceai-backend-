/**
 * WEBSOCKET CONNECTION TEST
 * Run this to verify WebSocket server is working
 */

import { WebSocket } from 'ws';

console.log('🧪 Testing WebSocket connection...\n');

const ws = new WebSocket('ws://localhost:5000/api/voice-stream');

ws.on('open', () => {
  console.log('✅ WebSocket connected successfully!');
  console.log('Sending test message...\n');
  
  ws.send(JSON.stringify({
    type: 'start_stream',
    token: 'test-token',
    chatId: 'test-chat',
    mode: 'moderate',
    jobContext: { jobTitle: 'Test', company: 'Test Inc' }
  }));
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data.toString());
    console.log('📨 Received:', message.type);
    console.log('   Data:', JSON.stringify(message, null, 2));
    
    if (message.type === 'stream_ready') {
      console.log('\n✅ Voice streaming is working!');
      console.log('Closing connection...');
      ws.close();
    }
  } catch (error) {
    console.log('📨 Received binary data:', data.length, 'bytes');
  }
});

ws.on('error', (error) => {
  console.error('❌ WebSocket error:', error.message);
  console.error('\n🔍 Troubleshooting:');
  console.error('1. Is the backend server running? (npm run dev)');
  console.error('2. Is port 5000 available?');
  console.error('3. Check backend console for errors');
});

ws.on('close', () => {
  console.log('🔌 WebSocket closed');
  process.exit(0);
});

// Timeout after 5 seconds
setTimeout(() => {
  if (ws.readyState !== WebSocket.OPEN) {
    console.error('\n❌ Connection timeout!');
    console.error('Backend server is not responding.');
    ws.close();
    process.exit(1);
  }
}, 5000);
