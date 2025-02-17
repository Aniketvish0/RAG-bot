import { DataAPIClient } from "@datastax/astra-db-ts";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import "dotenv/config";
import * as fs from "fs";
type SimilarityMatrics = "dot_product" | "cosine" | "euclidean";

const {
    ASTRA_DB_KEYSPACE,
    ASTRA_DB_APPLICATION_TOKEN,
    ASTRA_DB_API_ENDPOINT,
    ASTRA_DB_COLLECTION,
    GEMINI_API_KEY
} = process.env;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "text-embedding-004" });

const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN);
const db = client.db(ASTRA_DB_API_ENDPOINT, { namespace: ASTRA_DB_KEYSPACE });

const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 256,
    chunkOverlap: 100
});

// ✅ Create collection in Astra DB
const createCollection = async (similarityMatrics: SimilarityMatrics = "dot_product") => {
    const res = await db.createCollection(ASTRA_DB_COLLECTION, {
        vector: {
            dimension: 768,
            metric: similarityMatrics
        }
    });
    console.log("Collection created:", res);
};

// ✅ Load chat data and store embeddings
const loadChatData = async () => {
    const collection = await db.collection(ASTRA_DB_COLLECTION);
    const rawData = fs.readFileSync("app/scripts/parsed_chat.json", "utf-8");
    const chatData = JSON.parse(rawData);

    const formattedText = chatData.map(entry => `${entry.speaker}: ${entry.message}`).join("\n");

    const chunks = await splitter.splitText(formattedText);
    
    for (const chunk of chunks) {
        try {
          const embeddingResponse = await model.embedContent({
            content: {
                role: "user",  
                parts: [{ text: chunk }],
            }
        });

            const vector = embeddingResponse.embedding.values;
            const res = await collection.insertOne({
                $vector: vector,
                text: chunk
            });
            console.log("Inserted:", res);
        } catch (error) {
            console.error("Embedding error:", error);
        }
    }
};

(async () => {
    await createCollection();
    await loadChatData();
})();
