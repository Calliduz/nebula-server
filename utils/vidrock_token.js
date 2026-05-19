import crypto from "crypto";

export function generateToken(id, type, season, episode) {
  const s = type === "tv" ? `${id}_${season}_${episode}` : String(id);
  const key = Buffer.from("x7k9mPqT2rWvY8zA5bC3nF6hJ2lK4mN9", "utf8");
  const iv = Buffer.from("x7k9mPqT2rWvY8zA", "utf8");

  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);

  let encrypted = cipher.update(s, "utf8", "base64");
  encrypted += cipher.final("base64");

  let token = encrypted
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return token;
}
