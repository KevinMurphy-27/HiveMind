import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import './App.css';

// ─── Home View ────────────────────────────────────────────────────────────────
function HomeView({ onCreateRoom, onJoinRoom }) {
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [nameError, setNameError] = useState('');
  const [joinError, setJoinError] = useState('');
  const [creating, setCreating] = useState(false);

  function validateName() {
    if (!name.trim()) {
      setNameError('Please enter your name first.');
      return false;
    }
    setNameError('');
    return true;
  }

  async function handleCreate() {
    if (!validateName()) return;
    setCreating(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_SERVER_URL}/create-room`, { method: 'POST' });
      const { code } = await res.json();
      onCreateRoom(name.trim(), code);
    } catch {
      setNameError('Could not connect to server. Is it running?');
    } finally {
      setCreating(false);
    }
  }

  function handleJoin() {
    if (!validateName()) return;
    const code = joinCode.trim();
    if (code.length !== 4 || !/^\d{4}$/.test(code)) {
      setJoinError('Enter a valid 4-digit room code.');
      return;
    }
    setJoinError('');
    onJoinRoom(name.trim(), code);
  }

  return (
    <div className="home-view">
      <header className="home-header">
        <div className="logo">
          <span className="logo-hive">Hive</span>
          <span className="logo-notes">Notes</span>
        </div>
        <p className="home-tagline">Real-time collaborative notes, powered by AI</p>
      </header>

      <div className="home-card">
        <label className="field-label">Your name</label>
        <input
          className="text-input"
          type="text"
          placeholder="e.g. Alice"
          value={name}
          onChange={(e) => { setName(e.target.value); setNameError(''); }}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          maxLength={32}
        />
        {nameError && <p className="field-error">{nameError}</p>}

        <div className="home-actions">
          <div className="action-block">
            <h2 className="action-title">Start a session</h2>
            <p className="action-desc">Create a room and share the code with your team.</p>
            <button
              className="btn btn-primary"
              onClick={handleCreate}
              disabled={creating}
            >
              {creating ? 'Creating…' : 'Create Room'}
            </button>
          </div>

          <div className="divider-or"><span>or</span></div>

          <div className="action-block">
            <h2 className="action-title">Join a session</h2>
            <p className="action-desc">Enter the 4-digit code from the host.</p>
            <div className="join-row">
              <input
                className="text-input code-input"
                type="text"
                placeholder="1234"
                value={joinCode}
                onChange={(e) => { setJoinCode(e.target.value.replace(/\D/g, '').slice(0, 4)); setJoinError(''); }}
                onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                maxLength={4}
              />
              <button className="btn btn-secondary" onClick={handleJoin}>
                Join
              </button>
            </div>
            {joinError && <p className="field-error">{joinError}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Note Card ────────────────────────────────────────────────────────────────
function NoteCard({ note }) {
  const time = new Date(note.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="note-card">
      <div className="note-meta">
        <span className="note-author">{note.userName}</span>
        <span className="note-time">{time}</span>
      </div>
      <p className="note-content">{note.content}</p>
    </div>
  );
}

// ─── Room View ────────────────────────────────────────────────────────────────
function RoomView({ roomCode, userName, isHost, onLeave }) {
  const [notes, setNotes] = useState([]);
  const [noteText, setNoteText] = useState('');
  const [summary, setSummary] = useState(null);
  const [summarising, setSummarising] = useState(false);
  const [socketError, setSocketError] = useState('');
  const [connected, setConnected] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  const socketRef = useRef(null);
  const feedEndRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [notes]);

  useEffect(() => {
    const socket = io(import.meta.env.VITE_SERVER_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('join-room', { roomCode, userName, isHost });
    });

    socket.on('notes-update', (updatedNotes) => {
      setNotes(updatedNotes);
    });

    socket.on('summary-ready', (text) => {
      setSummary(text);
      setSummarising(false);
    });

    socket.on('error', (msg) => {
      setSocketError(msg);
      setSummarising(false);
    });

    socket.on('disconnect', () => {
      setConnected(false);
    });

    return () => {
      socket.disconnect();
    };
  }, [roomCode, userName, isHost]);

  const handleAddNote = useCallback(() => {
    const content = noteText.trim();
    if (!content || !socketRef.current) return;
    socketRef.current.emit('add-note', { roomCode, userName, content });
    setNoteText('');
    textareaRef.current?.focus();
  }, [noteText, roomCode, userName]);

  function handleSummarise() {
    if (!socketRef.current || summarising || notes.length === 0) return;
    setSummarising(true);
    setSummary(null);
    setSocketError('');
    socketRef.current.emit('summarise', { roomCode });
  }

  function handleCopyCode() {
    navigator.clipboard.writeText(roomCode).then(() => {
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    });
  }

  return (
    <div className="room-view">
      <header className="room-header">
        <div className="room-header-left">
          <span className="logo-small">
            <span className="logo-hive">Hive</span>
            <span className="logo-notes">Notes</span>
          </span>
          <span
            className={`status-dot ${connected ? 'online' : 'offline'}`}
            title={connected ? 'Connected' : 'Disconnected'}
          />
        </div>

        <div className="room-code-block">
          {isHost && <span className="room-code-label">Share code:</span>}
          <button
            className="room-code-badge"
            onClick={handleCopyCode}
            title="Click to copy"
          >
            {roomCode}
          </button>
          {codeCopied && <span className="copied-hint">Copied!</span>}
        </div>

        <div className="room-header-right">
          <span className="user-chip">{userName}</span>
          <button className="btn btn-ghost" onClick={onLeave}>Leave</button>
        </div>
      </header>

      <div className="room-body">
        <section className="notes-section">
          <div className="notes-feed">
            {notes.length === 0 ? (
              <div className="feed-empty">
                <p>No notes yet.</p>
                <p className="feed-empty-sub">Be the first to add one below!</p>
              </div>
            ) : (
              notes.map((note) => <NoteCard key={note.id} note={note} />)
            )}
            <div ref={feedEndRef} />
          </div>

          <div className="add-note-bar">
            <textarea
              ref={textareaRef}
              className="note-textarea"
              placeholder="Type your note… (Ctrl+Enter to submit)"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleAddNote();
              }}
              rows={3}
            />
            <button
              className="btn btn-primary add-note-btn"
              onClick={handleAddNote}
              disabled={!noteText.trim()}
            >
              Add Note
            </button>
          </div>
        </section>

        <aside className="room-sidebar">
          {isHost ? (
            <div className="summarise-block">
              <h3 className="sidebar-title">AI Summary</h3>
              <p className="sidebar-desc">
                Use Claude to summarise all notes in this room. Everyone will see the result.
              </p>
              <button
                className="btn btn-accent summarise-btn"
                onClick={handleSummarise}
                disabled={summarising || notes.length === 0}
              >
                {summarising ? (
                  <><span className="spinner" /> Summarising…</>
                ) : (
                  'Summarise Notes'
                )}
              </button>
              {notes.length === 0 && (
                <p className="sidebar-hint">Add some notes first.</p>
              )}
            </div>
          ) : (
            <div className="guest-info">
              <h3 className="sidebar-title">Collaborating</h3>
              <p className="sidebar-desc">
                Add notes to the session. The host can generate an AI summary when ready.
              </p>
            </div>
          )}

          {socketError && (
            <div className="error-box">
              <strong>Error:</strong> {socketError}
            </div>
          )}

          {summarising && !summary && (
            <div className="summary-loading">
              <span className="spinner large" />
              <p>Claude is reading the notes…</p>
            </div>
          )}

          {summary && (
            <div className="summary-panel">
              <div className="summary-header">
                <span className="summary-icon">✦</span>
                <h3 className="summary-title">AI Summary</h3>
              </div>
              <p className="summary-body">{summary}</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

// ─── App Root ─────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState('home');
  const [roomCode, setRoomCode] = useState('');
  const [userName, setUserName] = useState('');
  const [isHost, setIsHost] = useState(false);

  function handleCreateRoom(name, code) {
    setUserName(name);
    setRoomCode(code);
    setIsHost(true);
    setView('room');
  }

  function handleJoinRoom(name, code) {
    setUserName(name);
    setRoomCode(code);
    setIsHost(false);
    setView('room');
  }

  function handleLeave() {
    setView('home');
    setRoomCode('');
    setUserName('');
    setIsHost(false);
  }

  if (view === 'room') {
    return (
      <RoomView
        roomCode={roomCode}
        userName={userName}
        isHost={isHost}
        onLeave={handleLeave}
      />
    );
  }

  return <HomeView onCreateRoom={handleCreateRoom} onJoinRoom={handleJoinRoom} />;
}
