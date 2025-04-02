import { GoogleGenerativeAI } from '@google/generative-ai';
import { DataAPIClient } from "@datastax/astra-db-ts";
import "dotenv/config";

// Initialize Astra DB client
const client = new DataAPIClient(process.env.ASTRA_DB_APPLICATION_TOKEN!);
const db = client.db(process.env.ASTRA_DB_API_ENDPOINT!, { 
  namespace: process.env.ASTRA_DB_KEYSPACE 
});

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const chatModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-8b" });
const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });

export async function POST(req: Request) {
  try {
    const { messages } = await req.json();
    const lastMessage = messages[messages.length - 1].content;
    let docContext = "";
    // Get embedding for the user's query
    const embeddingResponse = await embeddingModel.embedContent({
      content: {
        role: "user",
        parts: [{ text: lastMessage }],
      }
    });
    const queryVector = embeddingResponse.embedding.values;

    // Search similar messages in Astra DB
    const collection = await db.collection(process.env.ASTRA_DB_COLLECTION!);
    const searchResults = await collection.find(
      {},
      {
        sort: {
          $vector: queryVector
        },
        limit: 8
      }
    ).toArray();

    // Create context from similar messages
    const context = searchResults.map(result => result.text).join("\n");
    docContext = JSON.stringify(context);

    const prompt = `
    I am giving you the context of the question , only give answer for the message according to the context given
    -----------------------------
    START_CONTEXT
    ${docContext}
    END_CONTEXT
    -------------------------------
    Based on the context above, please respond to: ${lastMessage}
    `

    async function fetchWithRetry() {
      let attempts = 3;
      let error;
      
      while (attempts > 0) {
        try {
          const result = await chatModel.generateContentStream({
            contents: [{ role: "user", parts: [{ text: prompt }]}],
            generationConfig: {
              temperature: 0.85,      
              topP: 0.92,             
              topK: 40,               
              maxOutputTokens: 250,   
            }
          });
          return result;
        } catch (err) {
          error = err;
          attempts -= 1;
          console.error(`Attempt failed. Retries left: ${attempts}`);
          if (attempts === 0) {
            throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

  //   
  const result = await fetchWithRetry();
  if (!result) throw new Error('No result from model');

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of result.stream) {
          const text = chunk.text();
          controller.enqueue(encoder.encode(text));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
    },
  });

} catch (error) {
  console.error('Error:', error);
  return new Response(
    JSON.stringify({ error: 'Failed to process message' }), 
    { 
      status: 500,
      headers: {
        'Content-Type': 'application/json',
      }
    }
  );
}
}
