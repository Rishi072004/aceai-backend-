// Test script for interview feedback endpoint
// Run: node test-feedback-endpoint.js

import fetch from 'node-fetch';

const API_URL = 'http://localhost:5000/api/ai/generate-interview-feedback';

// Sample conversation
const sampleConversation = [
  {
    type: 'ai',
    text: 'Hi there! Let\'s have a quick chat about the Software Engineer position. Can you start by telling me about a project you\'re really proud of?'
  },
  {
    type: 'user',
    text: 'Sure! I worked on a real-time notification system at my last company. It was built with Node.js and Redis. We handled about 100,000 messages per second and achieved 99.99% uptime.'
  },
  {
    type: 'ai',
    text: 'That sounds impressive! Can you walk me through the architecture? How did you handle scaling?'
  },
  {
    type: 'user',
    text: 'We used Redis pub/sub for message distribution and had multiple worker processes. We also implemented load balancing with Nginx and monitored everything with Prometheus.'
  },
  {
    type: 'ai',
    text: 'Great technical depth! How do you approach debugging issues in production?'
  },
  {
    type: 'user',
    text: 'I use structured logging first - we log everything in JSON format to ELK stack. Then I check metrics in Prometheus and Grafana. If it\'s a race condition, I\'ll reproduce it locally with detailed logs.'
  }
];

async function testFeedbackEndpoint() {
  try {
    console.log('🧪 Testing Interview Feedback Endpoint...\n');
    console.log('📝 Sample conversation length:', sampleConversation.length);
    console.log('🚀 Sending request to:', API_URL);

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token-for-testing'
      },
      body: JSON.stringify({
        conversation: sampleConversation,
        mode: 'technical',
        jobTitle: 'Senior Software Engineer',
        company: 'TechCorp',
        jobDescription: 'Looking for someone with 5+ years of backend experience'
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ Error response:', data);
      return;
    }

    console.log('\n✅ Feedback generated successfully!\n');
    console.log('📊 Overall Score:', data.data.feedback.overallScore);
    console.log('📌 Summary:', data.data.feedback.summary);
    console.log('\n💪 Strengths:');
    data.data.feedback.strengths?.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s}`);
    });
    console.log('\n🎯 Areas for Improvement:');
    data.data.feedback.improvements?.forEach((i, idx) => {
      console.log(`  ${idx + 1}. ${i}`);
    });
    console.log('\n📈 Category Scores:');
    console.log(`  Communication: ${data.data.feedback.communication?.score}/10`);
    console.log(`  Technical Knowledge: ${data.data.feedback.technicalKnowledge?.score}/10`);
    console.log(`  Problem Solving: ${data.data.feedback.problemSolving?.score}/10`);
    console.log(`  Professionalism: ${data.data.feedback.professionalism?.score}/10`);
    console.log('\n🔮 Recommendation:', data.data.feedback.recommendation);
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testFeedbackEndpoint();
