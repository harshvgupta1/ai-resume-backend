import Razorpay from "razorpay";
import dotenv from "dotenv";

dotenv.config();

const key_id = process.env.RAZORPAY_KEY_ID?.trim().replace(/^["']|["']$/g, "") || "rzp_test_TzlAXGhZ73pPvm";
const key_secret = process.env.RAZORPAY_KEY_SECRET?.trim().replace(/^["']|["']$/g, "") || "iB3PPzMG1GOjOz1oZHGZqJP4";

export const razorpayInstance = new Razorpay({
  key_id,
  key_secret,
});

export const RAZORPAY_CONFIG = {
  keyId: key_id,
  keySecret: key_secret,
};
