import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
useAccount,
useWriteContract,
useWaitForTransactionReceipt,
useReadContracts,
} from 'wagmi';
import {
Loader2,
AlertCircle,
ExternalLink,
RefreshCw,
} from 'lucide-react';

const CHANNELS_ADDRESS = '0x4d9bB6e20A0a2842CB1C4C22c4b3bEB2f03776E9';

const CHANNELS_ABI = [
{
name: 'channels',
type: 'function',
stateMutability: 'view',
inputs: [{ name: 'channelId', type: 'bytes32' }],
outputs: [
{ name: 'buyer', type: 'address' },
{ name: 'seller', type: 'address' },
{ name: 'deposit', type: 'uint128' },
{ name: 'settled', type: 'uint128' },
{ name: 'metadataHash', type: 'bytes32' },
{ name: 'deadline', type: 'uint256' },
{ name: 'settledAt', type: 'uint256' },
{ name: 'closeRequestedAt', type: 'uint256' },
{ name: 'status', type: 'uint8' },
],
},
{
name: 'requestClose',
type: 'function',
stateMutability: 'nonpayable',
inputs: [{ name: 'channelId', type: 'bytes32' }],
outputs: [],
},
{
name: 'withdraw',
type: 'function',
stateMutability: 'nonpayable',
inputs: [{ name: 'channelId', type: 'bytes32' }],
outputs: [],
},
];

const GRACE_PERIOD = 900;

function getStatus(session) {
if (session.status === 2) return 'settled';
if (session.status === 3) return 'timedout';
if (session.status === 0) return 'closed';
if (session.closeRequestedAt === 0) return 'active';
const now = Math.floor(Date.now() / 1000);
if (now < session.closeRequestedAt + GRACE_PERIOD) return 'closing';
return 'withdrawable';
}

const STATUS_STYLE = {
active: { label: 'Active', bg: 'rgba(16,185,129,0.15)', color: '#10b981' },
closing: { label: 'Closing', bg: 'rgba(245,158,11,0.15)', color: '#f59e0b' },
withdrawable: { label: 'Withdrawable', bg: 'rgba(59,130,246,0.15)', color: '#3b82f6' },
settled: { label: 'Settled', bg: 'rgba(156,163,175,0.15)', color: '#9ca3af' },
timedout: { label: 'Timed out', bg: 'rgba(156,163,175,0.15)', color: '#9ca3af' },
closed: { label: 'Closed', bg: 'rgba(156,163,175,0.15)', color: '#9ca3af' },
};

function formatTimeRemaining(closeRequestedAt) {
const now = Math.floor(Date.now() / 1000);
const remaining = closeRequestedAt + GRACE_PERIOD - now;
if (remaining <= 0) return '0:00';
const mins = Math.floor(remaining / 60);
const secs = remaining % 60;
return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatDate(ts) {
if (!ts) return '—';
const ms = ts > 1e12 ? ts : ts * 1000;
return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function truncateAddress(addr) {
return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '';
}

function ChannelRow({ session, onAction }) {
const { address, isConnected } = useAccount();
const status = getStatus(session);
const style = STATUS_STYLE[status];

const { writeContract: writeRequestClose, data: closeHash } = useWriteContract();
const { isLoading: closeConfirming, isSuccess: closeConfirmed } = useWaitForTransactionReceipt({ hash: closeHash });

const { writeContract: writeWithdraw, data: withdrawHash } = useWriteContract();
const { isLoading: withdrawConfirming, isSuccess: withdrawConfirmed } = useWaitForTransactionReceipt({ hash: withdrawHash });

const handleClose = () => {
writeRequestClose({
address: CHANNELS_ADDRESS,
abi: CHANNELS_ABI,
functionName: 'requestClose',
args: [session.channelId],
});
};

const handleWithdraw = () => {
writeWithdraw({
address: CHANNELS_ADDRESS,
abi: CHANNELS_ABI,
functionName: 'withdraw',
args: [session.channelId],
});
};

const deposit = Number(session.deposit) / 1e6;
const settled = Number(session.settled) / 1e6;

return (
<tr>
<td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }} title={session.seller}>
{truncateAddress(session.seller)}
</td>
<td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
{session.channelId.slice(0, 10)}...
</td>
<td>
<span style={{
padding: '0.25rem 0.5rem',
borderRadius: '6px',
fontSize: '0.75rem',
fontWeight: 600,
background: style.bg,
color: style.color,
}}>
{status === 'closing' ? `Closing ${formatTimeRemaining(session.closeRequestedAt)}` : style.label}
</span>
</td>
<td style={{ textAlign: 'right' }}>${deposit.toFixed(2)}</td>
<td style={{ textAlign: 'right' }}>${settled.toFixed(2)}</td>
<td>{formatDate(session.reservedAt)}</td>
<td>
{closeConfirmed || withdrawConfirmed ? (
<button className="btn-link" onClick={onAction} style={{ fontSize: '0.8rem', background: 'none', border: 'none', color: 'var(--info)', cursor: 'pointer' }}>
Refresh
</button>
) : status === 'active' && isConnected ? (
<button onClick={handleClose} disabled={closeConfirming} style={{
padding: '0.25rem 0.625rem', borderRadius: '6px', border: '1px solid var(--border)',
background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.75rem',
}}>
{closeConfirming ? 'Confirming...' : 'Close'}
</button>
) : status === 'closing' ? (
<span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Waiting...</span>
) : status === 'withdrawable' && isConnected ? (
<button onClick={handleWithdraw} disabled={withdrawConfirming} style={{
padding: '0.25rem 0.625rem', borderRadius: '6px', border: 'none',
background: 'var(--accent)', color: 'white', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600,
}}>
{withdrawConfirming ? 'Confirming...' : 'Withdraw'}
</button>
) : (
<span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>—</span>
)}
</td>
</tr>
);
}

function ChannelsView() {
const [rawChannels, setRawChannels] = useState([]);
const [loading, setLoading] = useState(true);

const fetchChannels = useCallback(async () => {
setLoading(true);
try {
const resp = await fetch('/api/channels');
const data = await resp.json();
setRawChannels(data.channels || []);
} catch (e) {
setRawChannels([]);
} finally {
setLoading(false);
}
}, []);

useEffect(() => { fetchChannels(); }, [fetchChannels]);

const contracts = useMemo(() => rawChannels.map(c => ({
address: CHANNELS_ADDRESS,
abi: CHANNELS_ABI,
functionName: 'channels',
args: [c.channelId],
})), [rawChannels]);

const { data: onChainReads, refetch: refetchOnChain, isFetching: onChainFetching } = useReadContracts({
contracts,
query: { enabled: contracts.length > 0, refetchOnWindowFocus: false },
});

const channels = useMemo(() => rawChannels.map((raw, i) => {
const read = onChainReads?.[i];
const tuple = read?.status === 'success' ? read.result : null;
const deposit = tuple ? Number(tuple.deposit) : Number(raw.reserveMax || 0);
const settled = tuple ? Number(tuple.settled) : Number(raw.cumulativeSigned || 0);
const closeRequestedAt = tuple ? Number(tuple.closeRequestedAt) : 0;
const status = tuple ? Number(tuple.status) : (raw.status === 'active' ? 1 : 2);
return {
channelId: raw.channelId,
seller: raw.seller || (tuple ? tuple.seller : ''),
deposit,
settled,
reservedAt: raw.reservedAt,
deadline: raw.deadline,
closeRequestedAt,
status,
};
}), [rawChannels, onChainReads]);

const activeChannels = channels.filter(c => c.status === 1);
const historyChannels = channels.filter(c => c.status !== 1);
const allChannels = [...activeChannels, ...historyChannels];

const reserved = activeChannels.reduce((a, c) => a + c.deposit / 1e6, 0);
const used = activeChannels.reduce((a, c) => a + c.settled / 1e6, 0);
const totalSpent = allChannels.reduce((a, c) => a + c.settled / 1e6, 0);

const refetch = async () => {
await fetchChannels();
await refetchOnChain();
};

return (
<div className="table-container" style={{ padding: '2rem' }}>
<div style={{ maxWidth: '900px' }}>
<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
<div>
<h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>Payment Channels</h2>
<p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
Payment channels between you and sellers. Reserve funds once, settle per-request.
</p>
</div>
<button onClick={refetch} disabled={loading || onChainFetching} style={{
display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 1rem',
borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent',
color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.875rem',
}}>
<RefreshCw size={14} style={{ animation: loading || onChainFetching ? 'spin 1s linear infinite' : 'none' }} />
Refresh
</button>
</div>

<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
<div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
<div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Active</div>
<div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{activeChannels.length} / {allChannels.length}</div>
</div>
<div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
<div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Reserved</div>
<div style={{ fontSize: '1.5rem', fontWeight: 700 }}>${reserved.toFixed(2)}</div>
</div>
<div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
<div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Used</div>
<div style={{ fontSize: '1.5rem', fontWeight: 700 }}>${used.toFixed(2)}</div>
</div>
<div style={{ background: 'var(--bg-secondary)', padding: '1.25rem', borderRadius: '12px' }}>
<div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Total Spent</div>
<div style={{ fontSize: '1.5rem', fontWeight: 700 }}>${totalSpent.toFixed(2)}</div>
</div>
</div>

{loading && allChannels.length === 0 ? (
<div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
<Loader2 size={32} className="spin" />
<p style={{ marginTop: '1rem' }}>Loading channels...</p>
</div>
) : allChannels.length === 0 ? (
<div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
No channels yet
</div>
) : (
<div style={{ overflowX: 'auto' }}>
<table className="table" style={{ minWidth: '700px' }}>
<thead>
<tr>
<th>Seller</th>
<th>Channel</th>
<th>Status</th>
<th style={{ textAlign: 'right' }}>Reserved</th>
<th style={{ textAlign: 'right' }}>Used</th>
<th>Opened</th>
<th></th>
</tr>
</thead>
<tbody>
{allChannels.map(session => (
<ChannelRow key={session.channelId} session={session} onAction={refetch} />
))}
</tbody>
</table>
</div>
)}
</div>
</div>
);
}

export default ChannelsView;
