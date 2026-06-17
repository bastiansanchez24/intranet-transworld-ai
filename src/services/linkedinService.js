const axios = require("axios");
const db = require("../db");
const qs = require("querystring");

const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const REDIRECT_URI = process.env.LINKEDIN_CALLBACK_URL;
const ORG_ID = process.env.LINKEDIN_ORG_ID;

// 1. Iniciar Login manual
function getAuthorizationUrl() {
  const scope = "r_organization_social";
  return `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scope)}`;
}

// 2. Canjear código
async function exchangeCodeForToken(code) {
  const url = "https://www.linkedin.com/oauth/v2/accessToken";
  const values = {
    grant_type: "authorization_code",
    code: code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  };

  try {
    const response = await axios.post(url, qs.stringify(values), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const accessToken = response.data.access_token;
    await db.query(
      `INSERT INTO system_config (key, value) VALUES ('linkedin_token', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [accessToken],
    );
    return accessToken;
  } catch (error) {
    throw new Error("Error autenticando con LinkedIn");
  }
}

// 3. Obtener Posts
async function getCompanyPosts() {
  try {
    const { rows } = await db.query(
      "SELECT value FROM system_config WHERE key = 'linkedin_token'",
    );
    if (rows.length === 0) return [];

    const token = rows[0].value;
    const organizationUrn = `urn:li:organization:${ORG_ID}`;

    const response = await axios.get(
      `https://api.linkedin.com/v2/ugcPosts?q=authors&authors=List(${encodeURIComponent(organizationUrn)})&count=5`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Restli-Protocol-Version": "2.0.0",
        },
      },
    );

    if (!response.data || !response.data.elements) return [];

    const posts = [];
    for (const post of response.data.elements) {
      try {
        let text = "Publicación de Transworld";
        let imageUrl = "/img/fondo-home.png"; // Fallback por defecto
        const postUrl = `https://www.linkedin.com/feed/update/${post.id}`;

        // 1. EXTRAER TEXTO
        if (
          post.specificContent &&
          post.specificContent["com.linkedin.ugc.ShareContent"]
        ) {
          const shareContent =
            post.specificContent["com.linkedin.ugc.ShareContent"];
          if (
            shareContent.shareCommentary &&
            shareContent.shareCommentary.text
          ) {
            text = shareContent.shareCommentary.text;
          }
        }

        // 2. EXTRAER IMAGEN DE LA API (Solo funciona para posts simples de 1 foto)
        const contentStr = JSON.stringify(post.specificContent || {});
        const urlsMatch = contentStr.match(
          /https:\/\/media\.licdn\.com\/dms\/image[^\s"\\]+/g,
        );

        if (urlsMatch && urlsMatch.length > 0) {
          imageUrl = urlsMatch[0];
        } else if (
          post.specificContent &&
          post.specificContent["com.linkedin.ugc.ShareContent"]
        ) {
          const mediaList =
            post.specificContent["com.linkedin.ugc.ShareContent"].media || [];
          if (
            mediaList.length > 0 &&
            mediaList[0].thumbnails &&
            mediaList[0].thumbnails.length > 0
          ) {
            imageUrl = mediaList[0].thumbnails[0].url;
          } else if (mediaList.length > 0 && mediaList[0].originalUrl) {
            imageUrl = mediaList[0].originalUrl;
          }
        }

        posts.push({ texto: text, imagen_url: imageUrl, enlace_url: postUrl });
      } catch (parseError) {
        console.log("[LINKEDIN] Error al procesar un post específico.");
      }
    }

    return posts.slice(0, 3);
  } catch (error) {
    console.error("[LINKEDIN API ERROR CRÍTICO]:", error.message);
    return [];
  }
}

module.exports = { getAuthorizationUrl, exchangeCodeForToken, getCompanyPosts };
