import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { config } from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
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

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

// Serve React frontend in production
const clientDist = join(__dirname, '../client/dist');
app.use(express.static(clientDist));

// In-memory room storage
// rooms[code] = { hostId: string|null, notes: Array<{ id, userName, content, timestamp }> }
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

// REST: create a new room
app.post('/create-room', (req, res) => {
  const { sessionType } = req.body ?? {};
  const type = SESSION_PROMPTS[sessionType] ? sessionType : 'meeting';

  let code;
  do {
    code = generateRoomCode();
  } while (rooms[code]);

  rooms[code] = { hostId: null, notes: [], sessionType: type };
  res.json({ code, sessionType: type });
});

// Socket.io events
io.on('connection', (socket) => {
  console.log(`[socket] connected: ${socket.id}`);

  socket.on('join-room', ({ roomCode, userName, isHost }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.userName = userName;

    if (isHost) {
      room.hostId = socket.id;
    }

    console.log(`[socket] ${userName} joined room ${roomCode} (host: ${isHost})`);
    // Send current notes and session type to the newly joined client
    socket.emit('notes-update', room.notes);
    socket.emit('session-type', room.sessionType);
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

    const note = {
      id: Date.now() + Math.random(),
      userName,
      content: finalContent,
      timestamp: new Date().toISOString(),
    };

    room.notes.push(note);
    io.to(roomCode).emit('notes-update', room.notes);
    console.log(`[socket] note added in room ${roomCode} by ${userName}`);
  });

  socket.on('summarise', async ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.notes.length === 0) {
      socket.emit('error', 'No notes to summarise');
      return;
    }

    const prompt = SESSION_PROMPTS[room.sessionType] ?? SESSION_PROMPTS.meeting;
    console.log(`[socket] summarising room ${roomCode} (${room.notes.length} notes, type: ${room.sessionType})`);

    try {
      const notesText = room.notes
        .map((n) => `${n.userName}: ${n.content}`)
        .join('\n');

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: prompt,
        messages: [
          { role: 'user', content: `Notes:\n${notesText}` },
        ],
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
    console.log(`[socket] disconnected: ${socket.id}`);
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
