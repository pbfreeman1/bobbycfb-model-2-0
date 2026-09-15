'use client';

const CARD = {
  display: 'block', textDecoration: 'none', border: '1px solid #2A332E', borderRadius: 8,
  padding: '32px 28px', background: '#161D1A', color: '#EDEFE8', width: 280,
};

export default function SportChooser() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '70vh', gap: 24, flexWrap: 'wrap' }}>
      <a href="/cfb/weekly-board" style={CARD}>
        <div style={{ fontSize: 28, marginBottom: 10 }}>🏈</div>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>College Football</div>
        <div style={{ fontSize: 13, color: '#8B9992' }}>Weekly board, PSS/MSS models, results tracking.</div>
      </a>
      <a href="/nfl/dashboard" style={CARD}>
        <div style={{ fontSize: 28, marginBottom: 10 }}>🏟️</div>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>NFL</div>
        <div style={{ fontSize: 13, color: '#8B9992' }}>Research and tracking tool — not a betting model.</div>
      </a>
    </div>
  );
}
