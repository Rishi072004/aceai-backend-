import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

console.log('🔍 Debugging Environment Variables...\n');

// Check if .env exists
const envPath = './.env';

console.log('📁 Checking for environment files:');
console.log(`.env exists: ${fs.existsSync(envPath)}\n`);

// Try loading .env
console.log('📖 Loading .env...');
dotenv.config({ path: envPath });

// Check if key variables are loaded
const requiredVars = ['PORT', 'MONGODB_URI', 'JWT_SECRET', 'NODE_ENV'];
console.log('🔑 Checking required environment variables:');

requiredVars.forEach(varName => {
  const value = process.env[varName];
  console.log(`${varName}: ${value ? '✅ SET' : '❌ NOT SET'}`);
  if (value && varName === 'JWT_SECRET') {
    console.log(`  Value: ${value.substring(0, 10)}...`);
  } else if (value) {
    console.log(`  Value: ${value}`);
  }
});

console.log('\n📋 All environment variables:');
Object.keys(process.env).forEach(key => {
  if (key.includes('NODE_') || key.includes('PORT') || key.includes('MONGODB') || key.includes('JWT') || key.includes('FRONTEND') || key.includes('RATE')) {
    console.log(`${key}: ${process.env[key]}`);
  }
});

console.log('\n💡 If variables are not loading:');
console.log('1. Make sure .env exists in the Backend directory');
console.log('2. Check that the file has the correct format (KEY=value)');
console.log('3. Ensure there are no spaces around the = sign');
console.log('4. Make sure MongoDB is running on localhost:27017'); 