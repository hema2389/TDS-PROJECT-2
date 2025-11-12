const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const axios = require('axios');
const { parse: parseCSV } = require('csv-parse/sync');
const pdf = require('pdf-parse');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// Configuration
const CONFIG = {
  email: process.env.EMAIL,
  secret: process.env.SECRET,
  claudeApiKey: process.env.CLAUDE_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY
};

// Store active sessions
const activeSessions = new Map();

// Claude API helper
async function callClaude(prompt, systemPrompt = '', imageData = null, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const messages = [{
        role: 'user',
        content: imageData 
          ? [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData }},
              { type: 'text', text: prompt }
            ]
          : prompt
      }];

      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: systemPrompt || undefined,
          messages,
          temperature: 0.1
        },
        {
          headers: {
            'x-api-key': CONFIG.claudeApiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          timeout: 60000
        }
      );

      return response.data.content[0].text;
    } catch (error) {
      console.error(`Claude API attempt ${attempt + 1} failed:`, error.message);
      if (attempt === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }
}

// Fetch quiz page
async function fetchQuizPage(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || 
                      process.env.CHROME_BIN || 
                      '/usr/bin/chromium-browser' || 
                      '/usr/bin/chromium'

    });
    
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForSelector('body', { timeout: 10000 });
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const content = await page.evaluate(() => document.body.innerText);
    return { content };
  } catch (error) {
    console.error('Error fetching quiz page:', error);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

// Download file
async function downloadFile(url) {
  const response = await axios.get(url, { 
    responseType: 'arraybuffer',
    timeout: 30000
  });
  return Buffer.from(response.data);
}

// Parse PDF
async function parsePDF(buffer) {
  const data = await pdf(buffer);
  return data.text;
}

// Process CSV
function processCSV(csvText) {
  return parseCSV(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });
}

// Analyze image
async function analyzeImage(imageBuffer, question) {
  const base64Image = imageBuffer.toString('base64');
  const prompt = `Analyze this image and answer: ${question}\n\nProvide a concise, accurate answer.`;
  return await callClaude(prompt, '', base64Image);
}

// Solve quiz
async function solveQuiz(url, sessionId) {
  try {
    console.log(`[${sessionId}] Fetching quiz from ${url}`);
    
    const { content } = await fetchQuizPage(url);
    console.log(`[${sessionId}] Quiz content:`, content.substring(0, 500));
    
    const analysisPrompt = `Analyze this quiz page and extract:
1. The question being asked
2. Any file URLs to download
3. The submit URL for the answer
4. The expected answer format (number, string, boolean, json, base64)

Quiz content:
${content}

Respond ONLY in JSON format:
{
  "question": "the question",
  "downloadUrls": ["url1"],
  "submitUrl": "submit endpoint",
  "answerFormat": "number"
}`;

    const analysisResult = await callClaude(analysisPrompt);
    const analysis = JSON.parse(analysisResult.replace(/```json\n?|\n?```/g, '').trim());
    
    console.log(`[${sessionId}] Analysis:`, analysis);
    
    const downloadedFiles = [];
    for (const fileUrl of analysis.downloadUrls || []) {
      try {
        console.log(`[${sessionId}] Downloading ${fileUrl}`);
        const fileBuffer = await downloadFile(fileUrl);
        
        let processedData;
        if (fileUrl.endsWith('.pdf')) {
          processedData = await parsePDF(fileBuffer);
        } else if (fileUrl.endsWith('.csv')) {
          processedData = processCSV(fileBuffer.toString());
        } else if (fileUrl.match(/\.(png|jpg|jpeg|gif)$/i)) {
          processedData = await analyzeImage(fileBuffer, analysis.question);
        } else {
          processedData = fileBuffer.toString();
        }
        
        downloadedFiles.push({ url: fileUrl, data: processedData });
      } catch (error) {
        console.error(`[${sessionId}] Error downloading ${fileUrl}:`, error);
      }
    }
    
    const solvingPrompt = `Answer this question based on the provided data.

Question: ${analysis.question}

Data:
${downloadedFiles.map(f => `From ${f.url}:\n${typeof f.data === 'string' ? f.data : JSON.stringify(f.data)}`).join('\n\n')}

Provide ONLY the answer in format: ${analysis.answerFormat}
For numbers, provide just the number.
For strings, provide just the string.
For JSON, provide valid JSON.
Be precise.`;

    let answer = await callClaude(solvingPrompt);
    answer = answer.trim();
    
    if (analysis.answerFormat === 'number') {
      answer = parseFloat(answer.replace(/[^0-9.-]/g, ''));
    } else if (analysis.answerFormat === 'boolean') {
      answer = answer.toLowerCase().includes('true');
    } else if (analysis.answerFormat === 'json') {
      try {
        answer = JSON.parse(answer.replace(/```json\n?|\n?```/g, '').trim());
      } catch (e) {
        console.error('Failed to parse JSON answer');
      }
    }
    
    console.log(`[${sessionId}] Computed answer:`, answer);
    
    const submitPayload = {
      email: CONFIG.email,
      secret: CONFIG.secret,
      url: url,
      answer: answer
    };
    
    console.log(`[${sessionId}] Submitting to ${analysis.submitUrl}`);
    const submitResponse = await axios.post(analysis.submitUrl, submitPayload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });
    
    console.log(`[${sessionId}] Submit response:`, submitResponse.data);
    
    return {
      success: true,
      result: submitResponse.data,
      answer: answer
    };
    
  } catch (error) {
    console.error(`[${sessionId}] Error:`, error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Solve quiz chain
async function solveQuizChain(initialUrl, sessionId) {
  let currentUrl = initialUrl;
  let attempts = 0;
  const maxAttempts = 10;
  const results = [];
  
  while (currentUrl && attempts < maxAttempts) {
    attempts++;
    console.log(`[${sessionId}] Attempt ${attempts}: ${currentUrl}`);
    
    const result = await solveQuiz(currentUrl, sessionId);
    results.push(result);
    
    if (result.success && result.result.url) {
      currentUrl = result.result.url;
    } else {
      break;
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  return results;
}

// Main endpoint
app.post('/quiz', async (req, res) => {
  const startTime = Date.now();
  const sessionId = `session_${Date.now()}`;
  
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }
    
    const { email, secret, url } = req.body;
    
    if (secret !== CONFIG.secret) {
      return res.status(403).json({ error: 'Invalid secret' });
    }
    
    if (email !== CONFIG.email) {
      return res.status(403).json({ error: 'Invalid email' });
    }
    
    console.log(`[${sessionId}] Received quiz request for ${url}`);
    
    res.status(200).json({ 
      status: 'processing',
      sessionId: sessionId,
      message: 'Quiz solving started'
    });
    
    activeSessions.set(sessionId, { status: 'processing', startTime });
    
    solveQuizChain(url, sessionId)
      .then(results => {
        activeSessions.set(sessionId, {
          status: 'completed',
          results,
          duration: Date.now() - startTime
        });
        console.log(`[${sessionId}] Completed in ${Date.now() - startTime}ms`);
      })
      .catch(error => {
        activeSessions.set(sessionId, {
          status: 'failed',
          error: error.message,
          duration: Date.now() - startTime
        });
        console.error(`[${sessionId}] Failed:`, error);
      });
    
  } catch (error) {
    console.error(`[${sessionId}] Error:`, error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Status endpoint
app.get('/status/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json(session);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Quiz API server running on port ${PORT}`);
  console.log(`📧 Email: ${CONFIG.email}`);
  console.log(`🔐 Secret: ${CONFIG.secret ? '***configured***' : '⚠️  NOT SET'}`);
  console.log(`🤖 Claude API: ${CONFIG.claudeApiKey ? '***configured***' : '⚠️  NOT SET'}`);
});
