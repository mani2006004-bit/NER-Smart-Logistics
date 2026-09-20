import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT) || 3000;
const maxBodyBytes = 512 * 1024;
const responseShape = {
    summary: "",
    route_assessment: "",
    key_factors: [],
    road_issue_summary: "",
    weather_summary: "",
    terrain_summary: "",
    risk_explanation: "",
    route_comparison: "",
    logistics_guidance: "",
    cautions: []
};

app.use(cors());
app.use(express.json({ limit: maxBodyBytes }));
app.use(express.static(__dirname));

app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
});

app.get("/api/geocode", async (request, response) => {
    const place = typeof request.query.q === "string" ? request.query.q.trim() : "";
    if (!place || place.length > 200) {
        return response.status(400).json({ error: "A valid place query is required." });
    }

    try {
        const upstreamUrl = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(place)}`;
        const upstreamResponse = await fetch(upstreamUrl, {
            headers: { "User-Agent": "NER-Smart-Logistics/1.0 route geocoder" }
        });
        if (!upstreamResponse.ok) {
            return response.status(502).json({ error: "Geocoding service is temporarily unavailable." });
        }
        return response.json(await upstreamResponse.json());
    } catch (error) {
        console.error("Geocoding proxy request failed:", error?.message || "unknown error");
        return response.status(502).json({ error: "Geocoding service is temporarily unavailable." });
    }
});

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value, maxLength = 1200) {
    return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function buildPrompt(routeFacts) {
    const factsJson = JSON.stringify(routeFacts, null, 2);

    return `You are the AI Route Intelligence layer for a logistics dashboard. Reason only from the supplied application facts. Do not invent weather, terrain, traffic, incidents, closures, map information, or route rankings. Do not call this a prediction model. Use uncertainty-aware wording such as may, could, indicates, reported, and based on the available data.

Return ONLY valid JSON matching this exact shape:
${JSON.stringify(responseShape, null, 2)}

Rules:
- Summarize the active route and factual trade-offs among alternatives without naming a best route, winner, or ranking.
- Distinguish calculated indicators from reported incidents.
- Mention missing data rather than filling gaps.
- Never claim flooding, landslides, road blockage, safety, or arrival as certain.
- Keep arrays concise, with at most 5 items each.
- Every statement must be supported by the supplied facts.

Application route facts:
${factsJson}`;
}

function normalizeResponse(value) {
    const source = isObject(value) ? value : {};
    const arrayValue = key => Array.isArray(source[key])
        ? source[key].filter(item => typeof item === "string").slice(0, 5).map(item => item.slice(0, 500))
        : [];
    const textValue = key => cleanText(source[key], 1600) || "No significant information available from the current route data.";

    return {
        summary: textValue("summary"),
        route_assessment: textValue("route_assessment"),
        key_factors: arrayValue("key_factors"),
        road_issue_summary: textValue("road_issue_summary"),
        weather_summary: textValue("weather_summary"),
        terrain_summary: textValue("terrain_summary"),
        risk_explanation: textValue("risk_explanation"),
        route_comparison: textValue("route_comparison"),
        logistics_guidance: textValue("logistics_guidance"),
        cautions: arrayValue("cautions")
    };
}

app.post("/api/ai/route-intelligence", async (request, response) => {
    if (!isObject(request.body) || !isObject(request.body.route)) {
        return response.status(400).json({ error: "A structured route intelligence payload is required." });
    }

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey || apiKey === "PASTE_KEY_HERE") {
        return response.status(503).json({ error: "Gemini AI is not configured. Add GEMINI_API_KEY to .env." });
    }

    try {
        const ai = new GoogleGenAI({ apiKey });
        const generate = () => ai.models.generateContent({
            model: "gemini-3.6-flash",
            contents: buildPrompt(request.body),
            config: {
                responseMimeType: "application/json",
                temperature: 0.2
            }
        });
        let result;
        try {
            result = await generate();
        } catch (error) {
            if (error?.error?.code !== 503) throw error;
            await new Promise(resolve => setTimeout(resolve, 1200));
            result = await generate();
        }
        const text = typeof result.text === "string" ? result.text : "";
        const parsed = JSON.parse(text);
        return response.json(normalizeResponse(parsed));
    } catch (error) {
        console.error("Gemini route intelligence request failed:", error?.message || "unknown error");
        return response.status(502).json({ error: "The AI route assessment is temporarily unavailable." });
    }
});

app.use((error, _request, response, _next) => {
    if (error?.type === "entity.too.large") {
        return response.status(413).json({ error: "The route intelligence payload is too large." });
    }
    console.error("Unhandled server error:", error?.message || "unknown error");
    return response.status(500).json({ error: "The server could not process the request." });
});

app.listen(port, () => {
    console.log(`NER Smart Logistics server listening on http://localhost:${port}`);
});
