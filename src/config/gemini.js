import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.warn("⚠️  [Gemini Warning] GEMINI_API_KEY is not set in backend/.env!");
  console.warn("   -> AI matching will use simulated intelligent scoring until you add your key.");
}

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

export const getGeminiModel = () => {
  if (!genAI) return null;
  return genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2, // Lower temperature for consistent deterministic scoring
    },
  });
};
