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

function generateRoomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// REST: create a new room
app.post('/create-room', (req, res) => {
  let code;
  do {
    code = generateRoomCode();
  } while (rooms[code]);

  rooms[code] = { hostId: null, notes: [] };
  res.json({ code });
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
    // Send current notes to the newly joined client
    socket.emit('notes-update', room.notes);
  });

  socket.on('add-note', ({ roomCode, userName, content }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const note = {
      id: Date.now() + Math.random(),
      userName,
      content,
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

    console.log(`[socket] summarising room ${roomCode} (${room.notes.length} notes)`);

    try {
      const notesText = room.notes
        .map((n) => `${n.userName}: ${n.content}`)
        .join('\n');

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `You are summarising collaborative notes from a group session. Provide a clear, concise summary that captures the key points, themes, and any action items mentioned.\n\nNotes:\n${notesText}`,
          },
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
app.get('*', (req, res) => {
  res.sendFile(join(clientDist, 'index.html'));
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`HiveNotes server running on http://localhost:${PORT}`);
});
