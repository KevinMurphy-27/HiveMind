import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import { createClient } from '@supabase/supabase-js';
import { jsPDF } from 'jspdf';
import './App.css';

// In dev, VITE_SERVER_URL points to localhost:3001.
// In production the frontend is served by the same Express server,
// so an empty string (same origin) works for both fetch and Socket.IO.
const SERVER_URL     = import.meta.env.VITE_SERVER_URL || '';
const SUPABASE_URL   = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON  = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ─── Home View ────────────────────────────────────────────────────────────────
const SESSION_TYPES = [
  { value: 'lecture',    icon: '🎓', label: 'College Lecture' },
  { value: 'meeting',    icon: '💼', label: 'Work Meeting' },
  { value: 'brainstorm', icon: '💡', label: 'Brainstorming' },
];

const SESSION_LABELS = {
  lecture:    { icon: '🎓', label: 'College Lecture' },
  meeting:    { icon: '💼', label: 'Work Meeting' },
  brainstorm: { icon: '💡', label: 'Brainstorming' },
};

function HomeView({ onCreateRoom, onJoinRoom }) {
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [nameError, setNameError] = useState('');
  const [joinError, setJoinError] = useState('');
  const [creating, setCreating] = useState(false);
  const [sessionType, setSessionType] = useState('meeting');

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
      const res = await fetch(`${SERVER_URL}/create-room`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionType }),
      });
      const { code, sessionType: confirmedType } = await res.json();
      onCreateRoom(name.trim(), code, confirmedType);
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
            <p className="action-desc">Choose a session type, then share the room code.</p>
            <div className="session-type-picker">
              {SESSION_TYPES.map(({ value, icon, label }) => (
                <button
                  key={value}
                  className={`session-type-card${sessionType === value ? ' active' : ''}`}
                  onClick={() => setSessionType(value)}
                  type="button"
                >
                  <span className="session-type-card-icon">{icon}</span>
                  {label}
                </button>
              ))}
            </div>
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
  const time = new Date(note.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="note-card">
      <div className="note-meta">
        <span className="note-author">{note.user_name}</span>
        <span className="note-time">{time}</span>
      </div>
      <p className="note-content">{note.content}</p>
    </div>
  );
}

// ─── Room View ────────────────────────────────────────────────────────────────
function RoomView({ roomCode, userName, isHost, sessionTypeProp, onLeave }) {
  const [notes, setNotes] = useState([]);
  const [noteText, setNoteText] = useState('');
  const [summary, setSummary] = useState(null);
  const [summarising, setSummarising] = useState(false);
  const [socketError, setSocketError] = useState('');
  const [connected, setConnected] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [sessionType, setSessionType] = useState(sessionTypeProp ?? 'meeting');
  const [clusters, setClusters] = useState([]);

  const [imageAttachment, setImageAttachment] = useState(null);
  const [imageError, setImageError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const socketRef = useRef(null);
  const feedEndRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [notes]);

  // ── Socket.IO — session control, errors, summary ──────────────────────────
  useEffect(() => {
    const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('join-room', { roomCode, userName, isHost });
    });

    socket.on('session-type', (type) => {
      setSessionType(type);
    });

    socket.on('summary-ready', (text) => {
      setSummary(text);
      setSummarising(false);
    });

    socket.on('error', (msg) => {
      setSocketError(msg);
      setSummarising(false);
      setSubmitting(false);
    });

    socket.on('disconnect', () => {
      setConnected(false);
    });

    return () => {
      socket.disconnect();
    };
  }, [roomCode, userName, isHost]);

  // ── Supabase Realtime — ideas ─────────────────────────────────────────────
  useEffect(() => {
    if (!SUPABASE_URL || !SUPABASE_ANON) return;
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON);

    // Load existing ideas
    sb.from('ideas')
      .select('*')
      .eq('session_code', roomCode)
      .order('created_at')
      .then(({ data }) => { if (data) setNotes(data); });

    // Subscribe to new inserts
    const ch = sb
      .channel(`ideas:${roomCode}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'ideas', filter: `session_code=eq.${roomCode}` },
        (payload) => {
          setNotes((prev) => [...prev, payload.new]);
          if (payload.new.user_name === userName) setSubmitting(false);
        },
      )
      .subscribe();

    return () => { sb.removeChannel(ch); };
  }, [roomCode, userName]);

  // ── Supabase Realtime — clusters (brainstorm only) ────────────────────────
  useEffect(() => {
    if (sessionType !== 'brainstorm' || !SUPABASE_URL || !SUPABASE_ANON) return;
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON);

    // Load existing clusters
    sb.from('clusters')
      .select('data')
      .eq('session_code', roomCode)
      .single()
      .then(({ data }) => { if (data?.data) setClusters(data.data); });

    // Subscribe to cluster upserts
    const ch = sb
      .channel(`clusters:${roomCode}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'clusters', filter: `session_code=eq.${roomCode}` },
        (payload) => { if (payload.new?.data) setClusters(payload.new.data); },
      )
      .subscribe();

    return () => { sb.removeChannel(ch); };
  }, [sessionType, roomCode]);

  const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const MAX_SIZE = 5 * 1024 * 1024;

  const handleImageSelect = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageError('');
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setImageError('Unsupported type. Use JPEG, PNG, GIF, or WebP.');
      e.target.value = '';
      return;
    }
    if (file.size > MAX_SIZE) {
      setImageError('Image exceeds 5 MB. Please choose a smaller file.');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const [header, base64Data] = dataUrl.split(',');
      if (!base64Data) { setImageError('Could not read file.'); return; }
      const mediaType = header.replace('data:', '').replace(';base64', '');
      setImageAttachment({ data: base64Data, mediaType, preview: dataUrl });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }, []);

  const handleRemoveImage = useCallback(() => {
    setImageAttachment(null);
    setImageError('');
  }, []);

  const handleAddNote = useCallback(() => {
    const content = noteText.trim();
    if ((!content && !imageAttachment) || !socketRef.current) return;
    setSubmitting(true);
    socketRef.current.emit('add-note', {
      roomCode,
      userName,
      content,
      ...(imageAttachment && {
        imageData: imageAttachment.data,
        imageMediaType: imageAttachment.mediaType,
      }),
    });
    setNoteText('');
    setImageAttachment(null);
    setImageError('');
    textareaRef.current?.focus();
  }, [noteText, imageAttachment, roomCode, userName]);

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

  function exportPDF() {
    if (!summary) return;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 40;
    const maxWidth = pageWidth - margin * 2;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('HiveMind — AI Summary', margin, 50);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(120);
    const sessionLabel = SESSION_LABELS[sessionType]?.label ?? sessionType;
    doc.text(
      `Session: ${sessionLabel}   |   Room: ${roomCode}   |   ${new Date().toLocaleString()}`,
      margin,
      68,
    );

    doc.setTextColor(30);
    doc.setFontSize(11);
    const lines = doc.splitTextToSize(summary, maxWidth);
    doc.text(lines, margin, 92);

    doc.save(`hivemind-summary-${roomCode}.pdf`);
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
          {sessionType && SESSION_LABELS[sessionType] && (
            <span className="session-type-badge">
              {SESSION_LABELS[sessionType].icon} {SESSION_LABELS[sessionType].label}
            </span>
          )}
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
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              style={{ display: 'none' }}
              onChange={handleImageSelect}
            />

            {imageAttachment && (
              <div className="image-preview-row">
                <img src={imageAttachment.preview} alt="Attachment preview" className="image-preview-thumb" />
                <button className="image-remove-btn" onClick={handleRemoveImage} title="Remove image" aria-label="Remove attached image">✕</button>
              </div>
            )}

            {imageError && <p className="image-error">{imageError}</p>}

            <div className="note-input-row">
              <button
                className="btn btn-secondary attach-btn"
                onClick={() => fileInputRef.current?.click()}
                title="Attach image"
                type="button"
              >
                📷
              </button>
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
                disabled={submitting || (!noteText.trim() && !imageAttachment)}
              >
                {submitting ? (
                  <><span className="spinner" /> Extracting…</>
                ) : (
                  <>Add Note<span className="btn-hint">Ctrl+↵</span></>
                )}
              </button>
            </div>
          </div>
        </section>

        <aside className="room-sidebar">
          {isHost ? (
            <div className="summarise-block">
              <h3 className="sidebar-title">AI Summary</h3>
              <p className="sidebar-desc">
                Summarise as a <strong>{SESSION_LABELS[sessionType]?.label ?? 'session'}</strong>. Everyone will see the result.
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
              <button className="export-btn" onClick={exportPDF}>
                ↓ Export as PDF
              </button>
            </div>
          )}

          {/* ── Live Clusters (brainstorm only) ── */}
          {sessionType === 'brainstorm' && clusters.length > 0 && (
            <div className="cluster-section">
              <div className="cluster-section-header">
                <span className="cluster-icon">◈</span>
                <h3 className="cluster-title">Live Clusters</h3>
                <span className="cluster-subtitle">auto-updates every minute</span>
              </div>
              <div className="cluster-grid">
                {clusters.map((c, i) => (
                  <div
                    key={c.label}
                    className="cluster-card"
                    style={{ animationDelay: `${i * 0.05}s` }}
                  >
                    <div className="cluster-label">{c.label}</div>
                    <ul className="cluster-ideas">
                      {c.ideas.map((idea, j) => <li key={j}>{idea}</li>)}
                    </ul>
                  </div>
                ))}
              </div>
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
  const [sessionType, setSessionType] = useState('meeting');

  function handleCreateRoom(name, code, type) {
    setUserName(name);
    setRoomCode(code);
    setSessionType(type ?? 'meeting');
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
    setSessionType('meeting');
  }

  if (view === 'room') {
    return (
      <RoomView
        roomCode={roomCode}
        userName={userName}
        isHost={isHost}
        sessionTypeProp={sessionType}
        onLeave={handleLeave}
      />
    );
  }

  return <HomeView onCreateRoom={handleCreateRoom} onJoinRoom={handleJoinRoom} />;
}
