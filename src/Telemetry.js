import React, { useEffect, useState, useRef, useCallback } from 'react';
import mqtt from 'mqtt';
import { Wifi, Activity, Server, Radio, AlertCircle } from 'lucide-react';
import { Card } from './components/SharedComponents';

const BROKER_WS = 'wss://broker.hivemq.com:8884/mqtt';
const TOPIC = 'telemetry/ajay-home/#';
const STALE_MS = 30_000;
const TICK_MS = 5_000;

function formatBytes(b) {
  if (b == null) return '—';
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB';
  return b + ' B';
}

function timeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

const BAND_LABEL = {
  '2.4GHz': '2.4 GHz',
  '5GHz':   '5 GHz',
  '6GHz':   '6 GHz',
};

function bandLabel(v) {
  return BAND_LABEL[v] || v || '—';
}

function pct(v) {
  return v != null ? `${v}%` : '—';
}

function StatCard({ icon: Icon, label, value, sub, color }) {
  return (
    <Card className="p-5 flex items-center space-x-4">
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${color}`}>
        <Icon className="w-6 h-6 text-white" />
      </div>
      <div>
        <p className="text-sm text-gray-500">{label}</p>
        <p className="text-2xl font-bold text-gray-900">{value}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </div>
    </Card>
  );
}

function RadioRow({ r }) {
  const chLoad = r['ChannelLoad'] ?? r['X_COMCAST-COM_ChannelUtilization'];
  const noise  = r['Noise'] ?? r['X_COMCAST-COM_NoiseFloor'];
  const bw     = r['CurrentOperatingChannelBandwidth'];

  return (
    <tr className="border-t border-gray-100 hover:bg-gray-50 transition-colors">
      <td className="px-4 py-3 text-sm font-medium text-gray-900">Radio {r.radio_index}</td>
      <td className="px-4 py-3 text-sm text-gray-600">{bandLabel(r.OperatingFrequencyBand)}</td>
      <td className="px-4 py-3 text-sm text-gray-600">
        {r.Channel ?? '—'}
        {bw ? <span className="ml-1 text-xs text-gray-400">({bw})</span> : null}
      </td>
      <td className="px-4 py-3 text-sm">
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
          r.Status === 'Up'
            ? 'bg-green-100 text-green-700'
            : r.Status
              ? 'bg-red-100 text-red-600'
              : 'bg-gray-100 text-gray-500'
        }`}>
          {r.Status || '—'}
        </span>
      </td>
      <td className="px-4 py-3 text-sm text-gray-600">{r.ActiveAssociatedDevices ?? '—'}</td>
      <td className="px-4 py-3 text-sm text-gray-600">{pct(chLoad)}</td>
      <td className="px-4 py-3 text-sm text-gray-600">{pct(r.Interference)}</td>
      <td className="px-4 py-3 text-sm text-gray-600">
        {noise != null ? `${noise} dBm` : '—'}
      </td>
      <td className="px-4 py-3 text-sm text-gray-600">{formatBytes(r.BytesSent)}</td>
      <td className="px-4 py-3 text-sm text-gray-600">{formatBytes(r.BytesReceived)}</td>
    </tr>
  );
}

function DeviceCard({ deviceId, entry, now }) {
  const isStale = now - entry.lastSeen > STALE_MS;
  const radios = Object.values(entry.radios).sort((a, b) => a.radio_index - b.radio_index);

  return (
    <Card className="overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between border-b border-gray-100">
        <div className="flex items-center space-x-3">
          <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${isStale ? 'bg-yellow-400' : 'bg-green-500'}`} />
          <div>
            <p className="font-semibold text-gray-900">{deviceId}</p>
            <p className="text-xs text-gray-400">{radios.length} radio{radios.length !== 1 ? 's' : ''}</p>
          </div>
        </div>
        <span className="text-xs text-gray-400">{timeAgo(entry.lastSeen)}</span>
      </div>

      {radios.length === 0 ? (
        <p className="px-5 py-4 text-sm text-gray-400">No radio data yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-gray-50">
                {['Radio', 'Band', 'Channel (BW)', 'Status', 'Clients', 'Ch. Load', 'Interference', 'Noise', 'TX', 'RX'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {radios.map(r => <RadioRow key={r.radio_index} r={r} />)}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function Telemetry() {
  const [devices, setDevices] = useState({});
  const [brokerStatus, setBrokerStatus] = useState('connecting');
  const [now, setNow] = useState(Date.now());
  const clientRef = useRef(null);

  const handleMessage = useCallback((topic, message) => {
    let payload;
    try { payload = JSON.parse(message.toString()); } catch { return; }

    const deviceId = payload.device_id;
    const idx = payload.radio_index;
    if (!deviceId || idx == null) return;

    setDevices(prev => {
      const entry = prev[deviceId] ?? { lastSeen: 0, radios: {} };
      return {
        ...prev,
        [deviceId]: {
          lastSeen: Date.now(),
          radios: { ...entry.radios, [idx]: payload },
        },
      };
    });
  }, []);

  useEffect(() => {
    const client = mqtt.connect(BROKER_WS, { reconnectPeriod: 3000 });
    clientRef.current = client;

    client.on('connect', () => {
      setBrokerStatus('connected');
      client.subscribe(TOPIC);
    });
    client.on('reconnect', () => setBrokerStatus('connecting'));
    client.on('error',   () => setBrokerStatus('error'));
    client.on('offline', () => setBrokerStatus('connecting'));
    client.on('message', handleMessage);

    return () => { client.end(true); };
  }, [handleMessage]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const deviceList = Object.entries(devices);
  const totalRadios = deviceList.reduce((s, [, e]) => s + Object.keys(e.radios).length, 0);
  const activeDevices = deviceList.filter(([, e]) => now - e.lastSeen <= STALE_MS).length;

  const brokerColor = {
    connected:  'bg-green-500',
    connecting: 'bg-yellow-400',
    error:      'bg-red-500',
  }[brokerStatus];

  const brokerLabel = {
    connected:  'Connected',
    connecting: 'Connecting…',
    error:      'Error',
  }[brokerStatus];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center space-x-3">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-600 to-blue-800 rounded-lg flex items-center justify-center">
            <Wifi className="w-4 h-4 text-white" />
          </div>
          <span className="text-lg font-bold text-gray-900">Device Telemetry</span>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <StatCard
            icon={Server}
            label="MQTT Broker"
            value={brokerLabel}
            sub="broker.hivemq.com"
            color={brokerColor}
          />
          <StatCard
            icon={Activity}
            label="Active Devices"
            value={activeDevices}
            sub={`${deviceList.length} total seen`}
            color="bg-blue-600"
          />
          <StatCard
            icon={Radio}
            label="Total Radios"
            value={totalRadios}
            sub="across all devices"
            color="bg-indigo-500"
          />
        </div>

        {/* device list */}
        {deviceList.length === 0 ? (
          <Card className="p-12 flex flex-col items-center text-center">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
              <Wifi className="w-8 h-8 text-gray-400" />
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-1">Waiting for telemetry</h3>
            <p className="text-sm text-gray-500 max-w-sm">
              No messages received yet. Make sure the device-telemetry container is running
              and configured to publish to broker.hivemq.com.
            </p>
            {brokerStatus !== 'connected' && (
              <div className="mt-4 flex items-center space-x-2 text-yellow-600 text-sm">
                <AlertCircle className="w-4 h-4" />
                <span>Broker not connected — check network connectivity</span>
              </div>
            )}
          </Card>
        ) : (
          <div className="space-y-6">
            {deviceList
              .sort(([, a], [, b]) => b.lastSeen - a.lastSeen)
              .map(([id, entry]) => (
                <DeviceCard key={id} deviceId={id} entry={entry} now={now} />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
