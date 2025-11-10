const axios = require('axios');

/**
 * LLM API Helper Functions
 * Supports Claude (Anthropic) and GPT (OpenAI)
 */

class LLMClient {
  constructor(claudeKey, openaiKey) {
    this.claudeKey = claudeKey;
    this.openaiKey = openaiKey;
  }

  /**
   * Call Claude API with retry logic
   */
  async callClaude(prompt, systemPrompt = '', imageData = null, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const messages = [{
          role: 'user',
          content: imageData 
            ? [
                { 
                  type: 'image', 
                  source: { 
                    type: 'base64', 
                    media_type: imageData.mediaType || 'image/png', 
                    data: imageData.data 
                  }
                },
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
            temperature: 0.1 // Lower temperature for more consistent results
          },
          {
            headers: {
              'x-api-key': this.claudeKey,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json'
            },
            timeout: 60000 // 60 second timeout
          }
        );

        return response.data.content[0].text;
      } catch (error) {
        console.error(`Claude API attempt ${attempt + 1} failed:`, error.message);
        
        if (attempt === retries - 1) {
          throw new Error(`Claude API failed after ${retries} attempts: ${error.message}`);
        }
        
        // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
  }

  /**
   * Call OpenAI API with retry logic
   */
  async callOpenAI(prompt, systemPrompt = '', imageData = null, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const messages = [
          systemPrompt ? { role: 'system', content: systemPrompt } : null,
          {
            role: 'user',
            content: imageData 
              ? [
                  { type: 'text', text: prompt },
                  { 
                    type: 'image_url', 
                    image_url: { 
                      url: `data:${imageData.mediaType || 'image/png'};base64,${imageData.data}`,
                      detail: 'high'
                    }
                  }
                ]
              : prompt
          }
        ].filter(Boolean);

        const response = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4o',
            messages,
            max_tokens: 4096,
            temperature: 0.1
          },
          {
            headers: {
              'Authorization': `Bearer ${this.openaiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 60000
          }
        );

        return response.data.choices[0].message.content;
      } catch (error) {
        console.error(`OpenAI API attempt ${attempt + 1} failed:`, error.message);
        
        if (attempt === retries - 1) {
          throw new Error(`OpenAI API failed after ${retries} attempts: ${error.message}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
  }

  /**
   * Smart LLM call - tries Claude first, falls back to OpenAI
   */
  async call(prompt, systemPrompt = '', imageData = null) {
    try {
      return await this.callClaude(prompt, systemPrompt, imageData);
    } catch (error) {
      console.error('Claude failed, falling back to OpenAI:', error.message);
      
      if (!this.openaiKey) {
        throw new Error('Both Claude and OpenAI failed, and no OpenAI key available');
      }
      
      return await this.callOpenAI(prompt, systemPrompt, imageData);
    }
  }

  /**
   * Extract structured data from LLM response
   */
  extractJSON(text) {
    // Remove markdown code blocks
    text = text.replace(/```json\n?|\n?```/g, '').trim();
    
    // Try to find JSON in the text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e) {
        throw new Error(`Failed to parse JSON: ${e.message}`);
      }
    }
    
    throw new Error('No JSON found in response');
  }

  /**
   * Extract number from LLM response
   */
  extractNumber(text) {
    // Remove any markdown or formatting
    text = text.replace(/```.*?```/gs, '').replace(/[*_]/g, '');
    
    // Look for numbers
    const numberMatch = text.match(/-?\d+\.?\d*/);
    if (numberMatch) {
      return parseFloat(numberMatch[0]);
    }
    
    throw new Error('No number found in response');
  }

  /**
   * Extract boolean from LLM response
   */
  extractBoolean(text) {
    text = text.toLowerCase().trim();
    
    if (text.includes('true') || text.includes('yes') || text === '1') {
      return true;
    }
    
    if (text.includes('false') || text.includes('no') || text === '0') {
      return false;
    }
    
    throw new Error('No clear boolean found in response');
  }

  /**
   * Clean and format LLM response based on expected type
   */
  formatAnswer(text, expectedType) {
    text = text.trim();
    
    switch (expectedType) {
      case 'number':
        return this.extractNumber(text);
      
      case 'boolean':
        return this.extractBoolean(text);
      
      case 'json':
        return this.extractJSON(text);
      
      case 'string':
        // Remove quotes if present
        return text.replace(/^["']|["']$/g, '');
      
      case 'base64':
        // Extract base64 data URI
        const base64Match = text.match(/data:[^;]+;base64,([A-Za-z0-9+/=]+)/);
        if (base64Match) {
          return base64Match[0];
        }
        // If already base64, return as is
        if (/^[A-Za-z0-9+/=]+$/.test(text)) {
          return text;
        }
        throw new Error('No valid base64 found in response');
      
      default:
        return text;
    }
  }
}

module.exports = LLMClient;