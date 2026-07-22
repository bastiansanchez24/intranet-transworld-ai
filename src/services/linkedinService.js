const axios = require("axios");
const db = require("../db");
const qs = require("querystring");
const fileStorage = require("./fileStorage");

const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const ORG_ID = process.env.LINKEDIN_ORG_ID;
const LINKEDIN_IMAGES_FOLDER = "linkedin_posts";
const FALLBACK_IMAGE = "/img/fondo-home.png";
const LINKEDIN_PLACEHOLDER_IMAGE = "/img/linkedin_off.jpg";
const LINKEDIN_COMPANY_URL =
  "https://www.linkedin.com/company/transworldpowerandtelecom";
function isLinkedInExplicitlyDisabled() {
  return process.env.LINKEDIN_ENABLED === "false";
}

function isLinkedInConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && ORG_ID);
}
const LINKEDIN_API_VERSION =
  process.env.LINKEDIN_API_VERSION?.trim() || "202601";

function getPlaceholderPosts() {
  return [
    {
      text: "Síguenos en LinkedIn",
      image_url: LINKEDIN_PLACEHOLDER_IMAGE,
      link_url: LINKEDIN_COMPANY_URL,
    },
  ];
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/$/, "");
}

function resolveBaseUrl(req) {
  const callbackUrl = process.env.LINKEDIN_CALLBACK_URL?.trim();
  if (callbackUrl) {
    return stripTrailingSlash(
      callbackUrl.replace(/\/auth\/linkedin\/callback\/?$/i, ""),
    );
  }

  const appBaseUrl = process.env.APP_BASE_URL?.trim();
  if (appBaseUrl) return stripTrailingSlash(appBaseUrl);

  if (req) {
    return stripTrailingSlash(`${req.protocol}://${req.get("host")}`);
  }

  return stripTrailingSlash(
    `http://localhost:${process.env.PORT || 3000}`,
  );
}

function getRedirectUri(req) {
  const explicit = process.env.LINKEDIN_CALLBACK_URL?.trim();
  if (explicit) return stripTrailingSlash(explicit);
  return `${resolveBaseUrl(req)}/auth/linkedin/callback`;
}

function getReauthUrl(req) {
  return `${resolveBaseUrl(req)}/auth/linkedin/login`;
}

function isSharePointImageUrl(url) {
  return Boolean(url && String(url).startsWith("/content/"));
}

function isLegacyExternalImageUrl(url) {
  if (!url) return true;
  const value = String(url);
  return (
    value.includes("cloudinary.com") ||
    value.includes("licdn.com") ||
    value.startsWith("http://") ||
    value.startsWith("https://")
  );
}

const TOKEN_KEY = "linkedin_token";
const REFRESH_KEY = "linkedin_refresh_token";
const EXPIRES_KEY = "linkedin_token_expires_at";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

/** Evita seguir golpeando /rest/images tras un 429 APPLICATION DAY. */
let imagesApiBlockedUntil = 0;

function markImagesApiThrottled(error) {
  const retryAfterSec = Number(error.response?.headers?.["retry-after"]);
  const cooldownMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
    ? retryAfterSec * 1000
    : 6 * 60 * 60 * 1000; // 6h por defecto (límite diario LinkedIn)
  imagesApiBlockedUntil = Date.now() + cooldownMs;
  console.warn(
    `[LINKEDIN] Images API en throttle diario (429). Sin más llamadas hasta ${new Date(imagesApiBlockedUntil).toISOString()}.`,
  );
}

function isUsableCachedImage(url) {
  if (!url || url === FALLBACK_IMAGE || url === LINKEDIN_PLACEHOLDER_IMAGE) {
    return false;
  }
  return isSharePointImageUrl(url) || String(url).startsWith("/");
}

function getLinkedInHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Restli-Protocol-Version": "2.0.0",
    "LinkedIn-Version": LINKEDIN_API_VERSION,
  };
}

function assertLinkedInConfig() {
  if (!CLIENT_ID || !CLIENT_SECRET || !ORG_ID) {
    throw new Error(
      "Faltan LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET o LINKEDIN_ORG_ID en .env",
    );
  }
}

function logLinkedInError(context, error) {
  const details = error.response?.data;
  const detailStr =
    typeof details === "object" ? JSON.stringify(details) : details || error.message;
  console.error(`[LINKEDIN] ${context}:`, detailStr);
  return detailStr;
}

async function saveConfigValue(key, value) {
  await db.query(
    `INSERT INTO system_config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value],
  );
}

async function saveTokens(accessToken, refreshToken, expiresIn) {
  await saveConfigValue(TOKEN_KEY, accessToken);

  if (refreshToken) {
    await saveConfigValue(REFRESH_KEY, refreshToken);
  }

  if (expiresIn) {
    const expiresAt = Date.now() + Number(expiresIn) * 1000;
    await saveConfigValue(EXPIRES_KEY, String(expiresAt));
  }
}

async function getAccessToken() {
  const { rows } = await db.query(
    "SELECT value FROM system_config WHERE key = $1",
    [TOKEN_KEY],
  );
  return rows.length > 0 ? rows[0].value : null;
}

async function getRefreshToken() {
  const { rows } = await db.query(
    "SELECT value FROM system_config WHERE key = $1",
    [REFRESH_KEY],
  );
  return rows.length > 0 ? rows[0].value : null;
}

function getAuthorizationUrl(req) {
  assertLinkedInConfig();
  const redirectUri = getRedirectUri(req);
  const scope = "r_organization_social";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope,
    prompt: "consent",
  });
  console.log("[LINKEDIN] Iniciando OAuth con redirect_uri:", redirectUri);
  return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
}

async function exchangeCodeForToken(code, req) {
  const redirectUri = getRedirectUri(req);
  const values = {
    grant_type: "authorization_code",
    code: code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  };

  try {
    const response = await axios.post(TOKEN_URL, qs.stringify(values), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const { access_token, refresh_token, expires_in } = response.data;
    await saveTokens(access_token, refresh_token, expires_in);

    if (!refresh_token) {
      console.warn(
        "[LINKEDIN] No se recibió refresh_token. El token dura ~60 días; vuelva a autorizar en",
        getReauthUrl(req),
        "antes de que expire.",
      );
    }

    return access_token;
  } catch (error) {
    const detail = logLinkedInError("Error autenticando", error);
    throw new Error(`Error autenticando con LinkedIn: ${detail}`);
  }
}

async function refreshAccessToken(req) {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    throw new Error(
      `No hay refresh token guardado. Visite ${getReauthUrl(req)} para reautorizar.`,
    );
  }

  const values = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  };

  try {
    const response = await axios.post(TOKEN_URL, qs.stringify(values), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const { access_token, refresh_token, expires_in } = response.data;
    await saveTokens(access_token, refresh_token || refreshToken, expires_in);
    console.log("[LINKEDIN] Access token renovado automáticamente.");
    return access_token;
  } catch (error) {
    logLinkedInError("Error renovando token", error);
    throw error;
  }
}

function postImageKey(enlaceUrl) {
  return (
    String(enlaceUrl || "post")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(-60) || "post"
  );
}

async function persistImageToSharePoint(imageUrl, enlaceUrl) {
  if (isSharePointImageUrl(imageUrl)) return imageUrl;
  if (!imageUrl || imageUrl === FALLBACK_IMAGE) return FALLBACK_IMAGE;
  if (!isLegacyExternalImageUrl(imageUrl)) {
    return String(imageUrl).startsWith("/") ? imageUrl : FALLBACK_IMAGE;
  }

  try {
    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 30000,
      headers: { "User-Agent": "Transworld-Intranet/1.0" },
    });
    const buffer = Buffer.from(response.data);
    if (!buffer.length) return FALLBACK_IMAGE;

    const ext = imageUrl.toLowerCase().includes(".png") ? ".png" : ".jpg";
    const saved = await fileStorage.saveFile(
      buffer,
      LINKEDIN_IMAGES_FOLDER,
      `${postImageKey(enlaceUrl)}${ext}`,
    );
    return saved.url;
  } catch (error) {
    console.warn("[LINKEDIN] No se pudo subir imagen a SharePoint:", error.message);
    return FALLBACK_IMAGE;
  }
}

function normalizeLinkedInPost(post) {
  return {
    text: post.text ?? post.texto ?? "Publicación de Transworld",
    image_url: post.image_url ?? post.imagen_url ?? FALLBACK_IMAGE,
    link_url: post.link_url ?? post.enlace_url ?? "#",
  };
}

async function enrichPostsWithSharePointImages(posts) {
  const enriched = [];
  for (const post of posts) {
    const image_url = await persistImageToSharePoint(
      post.image_url ?? post.imagen_url,
      post.link_url ?? post.enlace_url,
    );
    enriched.push(normalizeLinkedInPost({ ...post, image_url }));
  }
  return enriched;
}

function extractImageUrns(post) {
  const urns = [];
  const content = post.content || {};

  if (content.media?.id?.startsWith("urn:li:image:")) {
    urns.push(content.media.id);
  }
  if (content.article?.thumbnail?.startsWith("urn:li:image:")) {
    urns.push(content.article.thumbnail);
  }
  if (Array.isArray(content.multiImage?.images)) {
    for (const image of content.multiImage.images) {
      if (image.id?.startsWith("urn:li:image:")) urns.push(image.id);
    }
  }

  return urns;
}

async function fetchImageDownloadUrls(accessToken, imageUrns) {
  const uniqueUrns = [...new Set(imageUrns)].slice(0, 5);
  if (!uniqueUrns.length) return {};

  if (Date.now() < imagesApiBlockedUntil) {
    console.warn(
      "[LINKEDIN] Saltando resolución de imágenes (throttle diario activo).",
    );
    return {};
  }

  const idsParam = `List(${uniqueUrns.map((urn) => encodeURIComponent(urn)).join(",")})`;

  try {
    const response = await axios.get(
      `https://api.linkedin.com/rest/images?ids=${idsParam}`,
      { headers: getLinkedInHeaders(accessToken) },
    );

    const map = {};
    const results = response.data.results || {};
    for (const [urn, info] of Object.entries(results)) {
      if (info?.downloadUrl) map[urn] = info.downloadUrl;
    }
    return map;
  } catch (error) {
    if (error.response?.status === 429) {
      markImagesApiThrottled(error);
    }
    logLinkedInError("Error resolviendo imágenes", error);
    return {};
  }
}

async function parsePosts(response, accessToken) {
  if (!response.data?.elements) return [];

  const published = response.data.elements.filter(
    (post) => post.lifecycleState === "PUBLISHED",
  );
  const imageUrlMap = await fetchImageDownloadUrls(
    accessToken,
    published.flatMap(extractImageUrns),
  );

  const posts = [];
  for (const post of published) {
    try {
      const text = post.commentary?.trim() || "Publicación de Transworld";
      let imageUrl = FALLBACK_IMAGE;
      const postUrl = `https://www.linkedin.com/feed/update/${encodeURIComponent(post.id)}`;

      const imageUrns = extractImageUrns(post);
      if (imageUrns.length > 0 && imageUrlMap[imageUrns[0]]) {
        imageUrl = imageUrlMap[imageUrns[0]];
      } else {
        const contentStr = JSON.stringify(post.content || {});
        const urlsMatch = contentStr.match(
          /https:\/\/media\.licdn[^\s"\\]+/g,
        );
        if (urlsMatch?.length) imageUrl = urlsMatch[0];
      }

      posts.push({ text, image_url: imageUrl, link_url: postUrl });
    } catch (parseError) {
      console.log("[LINKEDIN] Error al procesar un post específico.");
    }
  }

  return posts.slice(0, 3);
}

async function fetchOrganizationPosts(accessToken) {
  assertLinkedInConfig();
  const organizationUrn = `urn:li:organization:${ORG_ID}`;
  const author = encodeURIComponent(organizationUrn);
  return axios.get(
    `https://api.linkedin.com/rest/posts?author=${author}&q=author&count=5&sortBy=LAST_MODIFIED`,
    { headers: getLinkedInHeaders(accessToken) },
  );
}

async function getPostsFromDb() {
  try {
    const { rows } = await db.query(
      `SELECT image_url, link_url
       FROM linkedin_posts
       ORDER BY created_at DESC
       LIMIT 3`,
    );

    return rows
      .filter((row) => row.image_url && row.link_url)
      .map((row) => normalizeLinkedInPost(row));
  } catch (error) {
    console.warn("[LINKEDIN] No se pudo leer linkedin_posts:", error.message);
    return [];
  }
}

async function syncPostsToDb(posts) {
  if (!posts.length) return;

  try {
    await db.query("DELETE FROM linkedin_posts");
    for (const post of posts.slice(0, 3)) {
      await db.query(
        `INSERT INTO linkedin_posts (image_url, link_url, created_at)
         VALUES ($1, $2, NOW())`,
        [post.image_url, post.link_url],
      );
    }
  } catch (error) {
    console.warn("[LINKEDIN] No se pudo sincronizar linkedin_posts:", error.message);
  }
}

function postFingerprint(posts) {
  return posts
    .map((post) => post.link_url || post.enlace_url || "")
    .filter(Boolean)
    .join("|");
}

/**
 * Si los posts de la API coinciden con el caché local y ya tienen imagen
 * usable (SharePoint), no vuelve a llamar Images API ni re-sube archivos.
 */
function reuseCachedPostsIfUnchanged(parsed, cached) {
  if (!parsed.length || !cached.length) return null;
  if (postFingerprint(parsed) !== postFingerprint(cached)) return null;
  if (!cached.every((post) => isUsableCachedImage(post.image_url))) return null;
  return cached.map(normalizeLinkedInPost);
}

async function fetchPostsFromApi(accessToken) {
  const response = await fetchOrganizationPosts(accessToken);
  const cached = await getPostsFromDb();

  // Resolver imágenes solo si hay posts nuevos/cambiados o el caché no sirve.
  // parsePosts llama a Images API; si el fingerprint coincide, lo evitamos.
  const published = (response.data?.elements || []).filter(
    (post) => post.lifecycleState === "PUBLISHED",
  );
  const previewLinks = published.slice(0, 3).map(
    (post) =>
      `https://www.linkedin.com/feed/update/${encodeURIComponent(post.id)}`,
  );
  const previewFingerprint = previewLinks.join("|");
  const cachedFingerprint = postFingerprint(cached);

  if (
    previewFingerprint &&
    previewFingerprint === cachedFingerprint &&
    cached.every((post) => isUsableCachedImage(post.image_url))
  ) {
    console.log(
      "[LINKEDIN] Posts sin cambios; reutilizando imágenes en caché (sin Images API).",
    );
    return cached.map(normalizeLinkedInPost);
  }

  const parsed = await parsePosts(response, accessToken);
  if (!parsed.length) return [];

  const reused = reuseCachedPostsIfUnchanged(parsed, cached);
  if (reused) {
    console.log(
      "[LINKEDIN] Reutilizando imágenes en caché tras fallo/throttle de Images API.",
    );
    return reused;
  }

  const posts = await enrichPostsWithSharePointImages(parsed);
  const hasUsableImages = posts.some((post) =>
    isUsableCachedImage(post.image_url),
  );

  // No pisar un buen caché con placeholders si LinkedIn no entregó imágenes.
  if (!hasUsableImages && cached.some((post) => isUsableCachedImage(post.image_url))) {
    console.warn(
      "[LINKEDIN] Sin imágenes nuevas (posible throttle); manteniendo caché local.",
    );
    return cached.map(normalizeLinkedInPost);
  }

  await syncPostsToDb(posts);
  return posts;
}

async function resolvePostsFallback() {
  const cached = await getPostsFromDb();
  if (cached.length) return cached;
  return getPlaceholderPosts();
}

async function getCompanyPosts() {
  if (isLinkedInExplicitlyDisabled()) {
    return getPlaceholderPosts();
  }

  if (!isLinkedInConfigured()) {
    return resolvePostsFallback();
  }

  let accessToken = await getAccessToken();
  if (!accessToken) {
    const cached = await getPostsFromDb();
    if (cached.length) {
      console.log("[LINKEDIN] Sin token activo; usando caché local.");
      return cached;
    }
    return getPlaceholderPosts();
  }

  try {
    const posts = await fetchPostsFromApi(accessToken);
    if (posts.length) return posts;
    return resolvePostsFallback();
  } catch (error) {
    if (error.response?.status !== 401) {
      logLinkedInError("Error obteniendo posts", error);
      return resolvePostsFallback();
    }

    const refreshToken = await getRefreshToken();
    if (!refreshToken) {
      console.warn(
        `[LINKEDIN] Token expirado y sin refresh token. Reautorice en ${getReauthUrl()}.`,
      );
      return resolvePostsFallback();
    }

    try {
      accessToken = await refreshAccessToken();
      const posts = await fetchPostsFromApi(accessToken);
      if (posts.length) return posts;
      return resolvePostsFallback();
    } catch (refreshError) {
      logLinkedInError("Renovación automática fallida", refreshError);
      console.warn(
        `[LINKEDIN] Token inválido; mostrando caché local. Reautorice en ${getReauthUrl()}.`,
      );
      return resolvePostsFallback();
    }
  }
}

module.exports = {
  getAuthorizationUrl,
  exchangeCodeForToken,
  getCompanyPosts,
  getPlaceholderPosts,
  getRedirectUri,
  getReauthUrl,
};
