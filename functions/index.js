const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getStorage } = require("firebase-admin/storage");
const crypto = require("crypto");

initializeApp();

// シークレット定義（デプロイ時に firebase functions:secrets:set で登録）
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const ELEVENLABS_API_KEY = defineSecret("ELEVENLABS_API_KEY");

// ── ① Claude vision: 写真 → 音楽プロンプト ──────────────────
async function generateMusicPrompt(base64, mediaType, apiKey) {
    const instruction =
        "You are a music director who translates the atmosphere of a photograph " +
        "into a prompt for a text-to-music AI (ElevenLabs Music). " +
        "Respond with ONLY a JSON object, no markdown, no preamble. Keys: " +
        '"title" (a short, evocative song title that fits the mood — Japanese or English, whichever suits the photo better. If Japanese, max 10 characters; if English, max 20 characters), ' +
        '"reading" (a short Japanese sentence describing the mood, for the user to read), ' +
        '"prompt" (an English comma-separated music prompt: genre, instruments, tempo in BPM, ' +
        "key/chord feel, and mood — suitable for ElevenLabs Music, under 600 characters), " +
        '"instrumental" (boolean: true if the scene calls for instrumental-only). ' +
        "Base every choice on concrete visual evidence: color, time of day, light, subject, emotion.";

    const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
            model: "claude-sonnet-4-5",
            max_tokens: 1000,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
                        { type: "text", text: instruction },
                    ],
                },
            ],
        }),
    });

    if (!res.ok) {
        const detail = await res.text();
        throw new HttpsError("internal", `Claude API error ${res.status}: ${detail.slice(0, 200)}`);
    }

    const data = await res.json();
    const text = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");

    const clean = text.replace(/```json|```/g, "").trim();
    let parsed;
    try {
        parsed = JSON.parse(clean);
    } catch {
        const s = clean.indexOf("{");
        const e = clean.lastIndexOf("}");
        if (s !== -1 && e !== -1) parsed = JSON.parse(clean.slice(s, e + 1));
        else throw new HttpsError("internal", "音楽プロンプトの解析に失敗しました。");
    }
    return parsed; // { reading, prompt, instrumental }
}

// ── ② ElevenLabs Music: プロンプト → 音楽バイナリ ────────────
async function generateMusic(prompt, instrumental, lengthMs, apiKey) {
    const res = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "xi-api-key": apiKey,
        },
        body: JSON.stringify({
            prompt: prompt,
            music_length_ms: lengthMs,
            force_instrumental: instrumental === true,
            model_id: "music_v1",
        }),
    });

    if (!res.ok) {
        const detail = await res.text();
        throw new HttpsError("internal", `ElevenLabs API error ${res.status}: ${detail.slice(0, 200)}`);
    }

    const songId = res.headers.get("song-id") || null;
    const arrayBuffer = await res.arrayBuffer(); // 音声バイナリが直接返る
    return { buffer: Buffer.from(arrayBuffer), songId };
}

// ── ③ Storage に保存して公開URLを得る ───────────────────────
async function saveToStorage(buffer, uid) {
    const bucket = getStorage().bucket();
    const id = crypto.randomUUID();
    const path = `bgm/${uid || "anon"}/${id}.mp3`;
    const file = bucket.file(path);

    // ダウンロードトークン付きで保存（署名URL不要で公開再生できる）
    const token = crypto.randomUUID();
    await file.save(buffer, {
        metadata: {
            contentType: "audio/mpeg",
            metadata: { firebaseStorageDownloadTokens: token },
        },
    });

    const encodedPath = encodeURIComponent(path);
    const url =
        `https://firebasestorage.googleapis.com/v0/b/${bucket.name}` +
        `/o/${encodedPath}?alt=media&token=${token}`;
    return { url, path };
}

// ── メイン: onCall ハンドラ ─────────────────────────────────
exports.composeBgmFromPhoto = onCall(
    {
        region: "asia-northeast1", // 東京リージョン
        secrets: [ANTHROPIC_API_KEY, ELEVENLABS_API_KEY],
        timeoutSeconds: 300, // 音楽生成の待ち時間を考慮
        memory: "512MiB",
    },
    async (request) => {
        const { imageBase64, mediaType, lengthMs } = request.data || {};

        if (!imageBase64 || !mediaType) {
            throw new HttpsError("invalid-argument", "画像データが必要です。");
        }

        // 長さは 10〜30秒の範囲に収める（プロトタイプ既定: 20秒）
        const safeLength = Math.min(Math.max(Number(lengthMs) || 20000, 10000), 30000);

        const uid = request.auth?.uid || null;

        // ① プロンプト生成
        const meta = await generateMusicPrompt(imageBase64, mediaType, ANTHROPIC_API_KEY.value());

        // ② 音楽生成
        const { buffer, songId } = await generateMusic(
            meta.prompt,
            meta.instrumental,
            safeLength,
            ELEVENLABS_API_KEY.value()
        );

        // ③ 保存
        const { url, path } = await saveToStorage(buffer, uid);

        return {
            title: meta.title,
            reading: meta.reading,
            prompt: meta.prompt,
            instrumental: meta.instrumental === true,
            audioUrl: url,
            storagePath: path,
            songId,
        };
    }
);
