import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { config } from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);

const allowedOrigins = process.env.CLIENT_ORIGIN
  ? [process.env.CLIENT_ORIGIN]
  : ['http://localhost:5173', 'http://127.0.0.1:5173'];

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 10e6,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

// Serve React frontend in production
const clientDist = join(__dirname, '../client/dist');
app.use(express.static(clientDist));

// In-memory room state — notes now live in Supabase; this tracks socket/host/interval info only
// rooms[code] = { hostId, sessionType, clusterIntervalId, lastClusteredCount }
const rooms = {};

const SESSION_PROMPTS = {
  lecture: `You are summarising collaborative notes from a college lecture. Multiple students have submitted their notes, which may include text and images of slides or whiteboards. Combine everything into one structured set of lecture notes with clear headings and bullet points. Then produce four additional sections: Key Terms — a glossary of any important concepts or definitions mentioned. Likely Exam Points — flag anything that sounds like it could appear in an exam question. Gaps and Confusion — identify any topics where students seemed unsure or notes were thin, so the lecturer knows what needs revisiting. Suggested Reading — if specific topics came up, suggest what a student should look into further. Write in a clear academic tone.`,

  meeting: `You are summarising collaborative notes from a work meeting. Multiple attendees have submitted their notes, which may include text and screenshots of screens or documents. Combine everything and produce the following sections: Summary — two to three sentences on what the meeting was about and what was decided. Action Items — a numbered list of tasks that need to happen, including who is responsible if any names were mentioned. Open Questions — anything that came up but was not resolved. Decisions Made — a clear list of things that were agreed on. Be concise and professional. Avoid padding. This summary may be sent directly to people who missed the meeting.`,

  brainstorm: `You are summarising ideas from a group brainstorming session. Multiple participants have submitted their ideas, which may include text and images of sketches or diagrams. Do not filter or judge any ideas. Group them into themes and give each theme a short label. Within each theme, list every idea submitted. After the grouped ideas, add two sections: Strongest Directions — pick the two or three ideas or themes that seem most developed or interesting and explain briefly why. Unexpected Angles — highlight any ideas that were unusual or surprising that the group might otherwise overlook. Keep the tone energetic and open. No idea should be dismissed.`,
};

function generateRoomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

async function extractTextFromImage(imageData, imageMediaType) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageData } },
        { type: 'text', text: 'Extract all readable content from this image — slide text, bullet points, headings, whiteboard content, handwritten notes, on-screen text, code, and describe any charts or graphs in plain text. Output only the raw content as plain notes, with no commentary, no "the image shows" phrases, and no formatting preamble.' }
      ]
    }]
  });
  return message.content[0].text.trim();
}

function mergeNoteContent(typedContent, extractedContent) {
  if (!typedContent) return extractedContent;
  if (!extractedContent) return typedContent;
  const seen = new Set();
  return `${typedContent}\n${extractedContent}`
    .split('\n')
    .filter(line => {
      const key = line.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join('\n');
}

// ── Clustering ────────────────────────────────────────────────────────────────

async function clusterIdeas(ideas) {
  const ideaList = ideas.map(i => `- ${i.content}`).join('\n');
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Group these brainstorm ideas into themed clusters.\nReturn ONLY a JSON array, no prose: [{"label":"short theme","ideas":["idea1","idea2"]},...]\n\nIdeas:\n${ideaList}`,
    }],
  });
  const text = msg.content[0].text;
  const match = text.match(/\[[\s\S]*\]/);
  return match ? JSON.parse(match[0]) : [];
}

function startClusteringInterval(roomCode) {
  if (!rooms[roomCode] || rooms[roomCode].clusterIntervalId) return;
  rooms[roomCode].lastClusteredCount = 0;

  rooms[roomCode].clusterIntervalId = setInterval(async () => {
    const room = rooms[roomCode];
    if (!room) return;

    const { data: ideas, error } = await supabase
      .from('ideas')
      .select('content')
      .eq('session_code', roomCode)
      .order('created_at');

    if (error) { console.error('[cluster] fetch error:', error.message); return; }
    if (!ideas || ideas.length === 0) return;
    if (ideas.length === room.lastClusteredCount) {
      console.log(`[cluster] no new ideas in room ${roomCode} — skipping`);
      return;
    }

    room.lastClusteredCount = ideas.length;
    console.log(`[cluster] clustering ${ideas.length} ideas for room ${roomCode}`);

    try {
      const clusters = await clusterIdeas(ideas);
      await supabase.from('clusters').upsert({
        session_code: roomCode,
        data: clusters,
        updated_at: new Date().toISOString(),
      });
      console.log(`[cluster] upserted ${clusters.length} clusters for room ${roomCode}`);
    } catch (err) {
      console.error('[cluster] Claude error:', err.message);
    }
  }, 60_000);
}

function stopClusteringInterval(roomCode) {
  const room = rooms[roomCode];
  if (room?.clusterIntervalId) {
    clearInterval(room.clusterIntervalId);
    room.clusterIntervalId = null;
  }
}

// ── REST: create a new room ───────────────────────────────────────────────────

app.post('/create-room', async (req, res) => {
  const { sessionType } = req.body ?? {};
  const type = SESSION_PROMPTS[sessionType] ? sessionType : 'meeting';

  let code;
  do {
    code = generateRoomCode();
  } while (rooms[code]);

  rooms[code] = { hostId: null, sessionType: type, clusterIntervalId: null, lastClusteredCount: 0 };

  // Persist session to Supabase
  const { error } = await supabase.from('sessions').insert({ code, session_type: type });
  if (error) console.error('[create-room] Supabase insert error:', error.message);

  // Start auto-clustering for brainstorm sessions
  if (type === 'brainstorm') startClusteringInterval(code);

  res.json({ code, sessionType: type });
});

// ── Socket.io events ──────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[socket] connected: ${socket.id}`);

  socket.on('join-room', async ({ roomCode, userName, isHost }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.userName = userName;

    if (isHost) room.hostId = socket.id;

    console.log(`[socket] ${userName} joined room ${roomCode} (host: ${isHost})`);

    // Send session type — client loads ideas directly from Supabase
    socket.emit('session-type', room.sessionType);

    // Record participant
    const { error } = await supabase.from('participants').insert({ session_code: roomCode, user_name: userName });
    if (error) console.error('[join-room] participant insert error:', error.message);
  });

  socket.on('add-note', async ({ roomCode, userName, content, imageData, imageMediaType }) => {
    const room = rooms[roomCode];
    if (!room) return;

    let finalContent = (content || '').trim();

    if (imageData && imageMediaType) {
      try {
        const extracted = await extractTextFromImage(imageData, imageMediaType);
        finalContent = mergeNoteContent(finalContent, extracted);
        console.log(`[socket] vision extraction complete for room ${roomCode} by ${userName}`);
      } catch (err) {
        console.error('[socket] vision extraction error:', err.message);
        socket.emit('error', 'Could not extract image content. Submitting typed text only.');
        if (!finalContent) return;
      }
    }

    if (!finalContent) return;

    // Insert into Supabase — Realtime delivers it to all subscribed clients
    const { error } = await supabase.from('ideas').insert({
      session_code: roomCode,
      user_name: userName,
      content: finalContent,
    });

    if (error) {
      console.error('[add-note] Supabase insert error:', error.message);
      socket.emit('error', 'Failed to save idea. Please try again.');
      return;
    }

    console.log(`[socket] idea added in room ${roomCode} by ${userName}`);
  });

  socket.on('summarise', async ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    // Fetch ideas from Supabase
    const { data: ideas, error } = await supabase
      .from('ideas')
      .select('user_name, content')
      .eq('session_code', roomCode)
      .order('created_at');

    if (error || !ideas || ideas.length === 0) {
      socket.emit('error', 'No ideas to summarise');
      return;
    }

    const prompt = SESSION_PROMPTS[room.sessionType] ?? SESSION_PROMPTS.meeting;
    console.log(`[socket] summarising room ${roomCode} (${ideas.length} ideas, type: ${room.sessionType})`);

    try {
      const notesText = ideas.map(n => `${n.user_name}: ${n.content}`).join('\n');

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: prompt,
        messages: [{ role: 'user', content: `Notes:\n${notesText}` }],
      });

      const summary = message.content[0].text;
      io.to(roomCode).emit('summary-ready', summary);
      console.log(`[socket] summary emitted to room ${roomCode}`);
    } catch (err) {
      console.error('[socket] summarise error:', err.message);
      socket.emit('error', 'Failed to generate summary. Please try again.');
    }
  });

  socket.on('disconnect', () => {
    const { roomCode } = socket.data;
    console.log(`[socket] disconnected: ${socket.id}`);

    if (roomCode && rooms[roomCode]) {
      const roomSockets = io.sockets.adapter.rooms.get(roomCode);
      if (!roomSockets || roomSockets.size === 0) {
        stopClusteringInterval(roomCode);
        delete rooms[roomCode];
        console.log(`[socket] room ${roomCode} cleaned up`);
      }
    }
  });
});

// Catch-all: serve React app for any non-API route
app.use((req, res) => {
  res.sendFile(join(clientDist, 'index.html'));
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`HiveNotes server running on http://localhost:${PORT}`);
});
