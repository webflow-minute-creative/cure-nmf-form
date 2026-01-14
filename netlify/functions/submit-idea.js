const Busboy = require("busboy");

// ---------- helpers ----------
function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(data)
  };
}

function slugify(str) {
  return String(str || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function webflowRequest(path, method, token, body) {
  const res = await fetch(`https://api.webflow.com/v2${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(`Webflow API ${res.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

// ---------- Netlify handler ----------
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204 };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  // ===== REQUIRED ENV VARS (Netlify → Environment variables) =====
  const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
  const WEBFLOW_SITE_ID = process.env.WEBFLOW_SITE_ID;
  const WEBFLOW_COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID;
  const CMS_IMAGE_FIELD_API_NAME = process.env.CMS_IMAGE_FIELD_API_NAME;
  // Example: forslags-image

  if (
    !WEBFLOW_TOKEN ||
    !WEBFLOW_SITE_ID ||
    !WEBFLOW_COLLECTION_ID ||
    !CMS_IMAGE_FIELD_API_NAME
  ) {
    return json(400, { error: "Missing environment variables" });
  }

  // ---------- parse multipart form ----------
  const contentType =
    event.headers["content-type"] || event.headers["Content-Type"];

  if (!contentType?.includes("multipart/form-data")) {
    return json(400, { error: "Expected multipart/form-data" });
  }

  const fields = {};
  let fileBuffer;
  let fileName;
  let fileType;

  const MAX_SIZE = 1 * 1024 * 1024; // 1MB
  const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

  try {
    await new Promise((resolve, reject) => {
      const bb = Busboy({ headers: { "content-type": contentType } });

      bb.on("field", (name, value) => {
        fields[name] = value;
      });

      bb.on("file", (_, file, info) => {
        fileName = info.filename;
        fileType = info.mimeType;

        if (!ALLOWED_TYPES.includes(fileType)) {
          reject(new Error("Invalid file type"));
          file.resume();
          return;
        }

        const chunks = [];
        let size = 0;

        file.on("data", (d) => {
          size += d.length;
          if (size > MAX_SIZE) {
            reject(new Error("File exceeds 1MB"));
            file.resume();
            return;
          }
          chunks.push(d);
        });

        file.on("end", () => {
          fileBuffer = Buffer.concat(chunks);
        });
      });

      bb.on("finish", resolve);
      bb.on("error", reject);

      bb.end(
        Buffer.from(
          event.body,
          event.isBase64Encoded ? "base64" : "utf8"
        )
      );
    });

    if (!fileBuffer) {
      return json(400, { error: "Image file required" });
    }

    // ---------- 1. Ask Webflow for upload URL ----------
    const assetInit = await webflowRequest(
      `/sites/${WEBFLOW_SITE_ID}/assets`,
      "POST",
      WEBFLOW_TOKEN,
      {
        fileName,
        contentType: fileType,
        fileSize: fileBuffer.length
      }
    );

    const { uploadUrl, assetUrl } = assetInit;

    // ---------- 2. Upload file ----------
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": fileType },
      body: fileBuffer
    });

    if (!uploadRes.ok) {
      throw new Error("Asset upload failed");
    }

    // ---------- 3. Create CMS item ----------
    const title =
      fields.title ||
      fields.name ||
      fields.Tittel ||
      "New idea";

    const cmsFields = {
      name: title,
      slug: slugify(title),
      [CMS_IMAGE_FIELD_API_NAME]: { url: assetUrl }
    };

    // Optional text fields (update API names if needed)
    if (fields.description) {
      cmsFields["forslags-description"] = fields.description;
    }

    const created = await webflowRequest(
      `/collections/${WEBFLOW_COLLECTION_ID}/items`,
      "POST",
      WEBFLOW_TOKEN,
      {
        isDraft: true,
        fieldData: cmsFields
      }
    );

    return json(200, { ok: true, item: created });

  } catch (err) {
    return json(500, { error: err.message });
  }
};
