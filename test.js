const axios = require('axios');
require('dotenv').config();

const API_URL = process.env.API_URL || 'http://localhost:8080';
const EMAIL = process.env.EMAIL;
const SECRET = process.env.SECRET;

console.log('='.repeat(60));
console.log('🧪 Testing LLM Quiz API');
console.log('='.repeat(60));
console.log(`API URL: ${API_URL}`);
console.log(`Email: ${EMAIL}`);
console.log('='.repeat(60));
console.log();

async function runTests() {
  let passed = 0;
  let failed = 0;

  // Test 1: Health Check
  try {
    console.log('1️⃣  Testing Health Check...');
    const response = await axios.get(`${API_URL}/health`, { timeout: 5000 });
    if (response.status === 200 && response.data.status === 'ok') {
      console.log('✅ PASS: Health check successful\n');
      passed++;
    } else {
      console.log('❌ FAIL: Unexpected health response\n');
      failed++;
    }
  } catch (error) {
    console.log(`❌ FAIL: ${error.message}\n`);
    failed++;
  }

  // Test 2: Valid Request
  try {
    console.log('2️⃣  Testing Valid Quiz Request...');
    const response = await axios.post(
      `${API_URL}/quiz`,
      {
        email: EMAIL,
        secret: SECRET,
        url: 'https://tds-llm-analysis.s-anand.net/demo'
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    if (response.status === 200 && response.data.sessionId) {
      console.log('✅ PASS: Valid request accepted\n');
      passed++;
    } else {
      console.log('❌ FAIL: Unexpected response\n');
      failed++;
    }
  } catch (error) {
    console.log(`❌ FAIL: ${error.message}\n`);
    failed++;
  }

  // Test 3: Invalid Secret
  try {
    console.log('3️⃣  Testing Invalid Secret (should return 403)...');
    await axios.post(
      `${API_URL}/quiz`,
      {
        email: EMAIL,
        secret: 'wrong-secret',
        url: 'https://tds-llm-analysis.s-anand.net/demo'
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
    );
    console.log('❌ FAIL: Should have rejected with 403\n');
    failed++;
  } catch (error) {
    if (error.response?.status === 403) {
      console.log('✅ PASS: Correctly rejected with 403\n');
      passed++;
    } else {
      console.log(`❌ FAIL: Got ${error.response?.status || error.message}\n`);
      failed++;
    }
  }

  // Summary
  console.log('='.repeat(60));
  console.log('📊 Test Summary');
  console.log('='.repeat(60));
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`Success Rate: ${Math.round((passed / (passed + failed)) * 100)}%`);
  console.log('='.repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
