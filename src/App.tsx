import { useEffect, useRef, useState } from 'react';
import { parseDeviceMessage, type DeviceTelemetry } from './deviceProtocol';

interface BluetoothCharacteristic extends EventTarget {
  value: DataView | null
  startNotifications(): Promise<BluetoothCharacteristic>
}

interface BluetoothService {
  getCharacteristic(uuid: string): Promise<BluetoothCharacteristic>
}

interface BluetoothServer {
  connect(): Promise<BluetoothServer>
  disconnect(): void
  getPrimaryService(uuid: string): Promise<BluetoothService>
}

interface BluetoothDevice extends EventTarget {
  name?: string
  gatt?: BluetoothServer
}

interface BluetoothApi {
  requestDevice(options: { filters: { services: string[] }[] }): Promise<BluetoothDevice>
}

const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_TX_CHARACTERISTIC_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

export default function App() {
  const [activeTab, setActiveTab] = useState<'overview' | 'location' | 'alerts' | 'activity' | 'hardware'>('overview');
  const [demoAlertActive, setDemoAlertActive] = useState(false);
  const [contactAlertStatus, setContactAlertStatus] = useState<'standby' | 'demo' | 'setup-required'>('standby');
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>('light');
  const [telemetry, setTelemetry] = useState<DeviceTelemetry | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [connectionError, setConnectionError] = useState('');
  const [connectedDeviceName, setConnectedDeviceName] = useState('');
  const [shareFeedback, setShareFeedback] = useState('');
  const [notifications, setNotifications] = useState<{ id: number; type: string; title: string; time: string; detail: string }[]>([]);
  const deviceRef = useRef<BluetoothDevice | null>(null);
  const characteristicRef = useRef<BluetoothCharacteristic | null>(null);
  const telemetryListenerRef = useRef<EventListener | null>(null);
  const disconnectListenerRef = useRef<EventListener | null>(null);
  const connectInProgressRef = useRef(false);
  const previousAlertActiveRef = useRef(false);
  const lineBufferRef = useRef('');
  const decoderRef = useRef(new TextDecoder());
  const [activityLogs, setActivityLogs] = useState<string[]>([
    'System initialized in demo mode',
    'Ready to connect to an ESP32 over Bluetooth'
  ]);

  useEffect(() => {
    return () => {
      const device = deviceRef.current;
      const characteristic = characteristicRef.current;
      if (characteristic && telemetryListenerRef.current) {
        characteristic.removeEventListener('characteristicvaluechanged', telemetryListenerRef.current);
      }
      if (device && disconnectListenerRef.current) {
        device.removeEventListener('gattserverdisconnected', disconnectListenerRef.current);
      }
      device?.gatt?.disconnect();
    };
  }, []);

  const addActivityLog = (message: string) => {
    const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setActivityLogs(prev => [`[${timeNow}] ${message}`, ...prev].slice(0, 50));
  };

  const connectToDevice = async () => {
    if (connectInProgressRef.current) return;
    connectInProgressRef.current = true;
    setConnectionError('');
    setConnectionStatus('connecting');
    setTelemetry(null);
    lineBufferRef.current = '';
    decoderRef.current = new TextDecoder();

    let device: BluetoothDevice | null = null;
    try {
      if (!window.isSecureContext) {
        throw new Error('Bluetooth requires a secure page (HTTPS or localhost)')
      }

      const bluetooth = (navigator as Navigator & { bluetooth?: BluetoothApi }).bluetooth;
      if (!bluetooth) {
        throw new Error('Bluetooth is not supported in this browser. Use Chrome or Edge.')
      }

      device = await bluetooth.requestDevice({
        filters: [{ services: [UART_SERVICE_UUID] }],
      });
      deviceRef.current = device;

      const server = await device.gatt?.connect();
      if (!server) throw new Error('Could not connect to the selected Bluetooth device');
      const service = await server.getPrimaryService(UART_SERVICE_UUID);
      const characteristic = await service.getCharacteristic(UART_TX_CHARACTERISTIC_UUID);
      characteristicRef.current = characteristic;

      const telemetryListener: EventListener = () => {
        const value = characteristic.value;
        if (!value) return;
        const chunk = decoderRef.current.decode(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
          { stream: true },
        );
        lineBufferRef.current += chunk;

        if (lineBufferRef.current.length > 16_384) {
          lineBufferRef.current = '';
          const message = 'Bluetooth telemetry line exceeded 16 KB; send one JSON message per line'
          setConnectionError(message);
          addActivityLog(`Telemetry error: ${message}`);
          return;
        }

        const lines = lineBufferRef.current.split('\n');
        lineBufferRef.current = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            setTelemetry(parseDeviceMessage(line.trim()));
            setConnectionError('');
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Invalid device message';
            setConnectionError(message);
            addActivityLog(`Telemetry error: ${message}`);
          }
        }
      };
      telemetryListenerRef.current = telemetryListener;
      characteristic.addEventListener('characteristicvaluechanged', telemetryListener);

      const disconnectListener: EventListener = () => {
        if (deviceRef.current !== device) return;
        if (telemetryListenerRef.current) {
          characteristic.removeEventListener('characteristicvaluechanged', telemetryListenerRef.current);
        }
        device?.removeEventListener('gattserverdisconnected', disconnectListener);
        deviceRef.current = null;
        characteristicRef.current = null;
        telemetryListenerRef.current = null;
        disconnectListenerRef.current = null;
        lineBufferRef.current = '';
        decoderRef.current = new TextDecoder();
        setConnectionStatus('disconnected');
        setConnectedDeviceName('');
        setTelemetry(null);
        setConnectionError('');
        addActivityLog('ESP32 Bluetooth connection closed');
      };
      disconnectListenerRef.current = disconnectListener;
      device.addEventListener('gattserverdisconnected', disconnectListener);

      await characteristic.startNotifications();
      setConnectedDeviceName(device.name || 'ESP32 device');
      setConnectionStatus('connected');
      addActivityLog(`Connected to ${device.name || 'ESP32 device'} over Bluetooth`);
    } catch (error) {
      if (device) {
        const characteristic = characteristicRef.current;
        if (characteristic && telemetryListenerRef.current) {
          characteristic.removeEventListener('characteristicvaluechanged', telemetryListenerRef.current);
        }
        if (disconnectListenerRef.current) {
          device.removeEventListener('gattserverdisconnected', disconnectListenerRef.current);
        }
        deviceRef.current = null;
        characteristicRef.current = null;
        telemetryListenerRef.current = null;
        disconnectListenerRef.current = null;
        device.gatt?.disconnect();
      }

      const cancelled = error instanceof DOMException && error.name === 'NotFoundError';
      if (cancelled) {
        setConnectionStatus('disconnected');
      } else {
        const message = error instanceof Error ? error.message : 'Could not connect to the Bluetooth device';
        setConnectionStatus('error');
        setConnectionError(message);
        addActivityLog(`Connection error: ${message}`);
      }
    } finally {
      connectInProgressRef.current = false;
    }
  };

  const disconnectFromDevice = () => {
    const device = deviceRef.current;
    const characteristic = characteristicRef.current;
    if (characteristic && telemetryListenerRef.current) {
      characteristic.removeEventListener('characteristicvaluechanged', telemetryListenerRef.current);
    }
    if (device && disconnectListenerRef.current) {
      device.removeEventListener('gattserverdisconnected', disconnectListenerRef.current);
    }
    deviceRef.current = null;
    characteristicRef.current = null;
    telemetryListenerRef.current = null;
    disconnectListenerRef.current = null;
    lineBufferRef.current = '';
    decoderRef.current = new TextDecoder();
    device?.gatt?.disconnect();
    setTelemetry(null);
    setConnectedDeviceName('');
    setConnectionStatus('disconnected');
    setConnectionError('');
    addActivityLog('Disconnected from Bluetooth device');
  };

  const isDeviceConnected = connectionStatus === 'connected';
  const isAlertActive = isDeviceConnected ? telemetry?.fallDetected === true : demoAlertActive;
  const batteryLevel = isDeviceConnected ? telemetry?.batteryPercent ?? null : 82;
  const gps = isDeviceConnected ? telemetry?.gps : undefined;
  const hasGpsFix = gps !== undefined && gps.fix !== false;
  const mapLocation = gps && hasGpsFix
    ? gps
    : isDeviceConnected
      ? null
      : { latitude: 2.9292, longitude: 101.7839 };
  const mapsApiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  const mapEmbedUrl = mapsApiKey && mapLocation
    ? `https://www.google.com/maps/embed/v1/view?key=${encodeURIComponent(mapsApiKey)}&center=${mapLocation.latitude},${mapLocation.longitude}&zoom=16`
    : null;
  const coordinates = gps && hasGpsFix
    ? `${gps.latitude.toFixed(4)}°, ${gps.longitude.toFixed(4)}°`
    : isDeviceConnected ? 'Waiting for GPS fix' : '2.9292° N, 101.7839° E';
  const safetyStatus = isDeviceConnected && telemetry?.fallDetected === undefined
    ? 'Waiting for data'
    : isAlertActive ? 'Alert active' : 'Secure';
  const motionStatus = isDeviceConnected
    ? telemetry?.fallDetected === undefined
      ? 'Waiting for sensor data'
      : isAlertActive ? 'Fall alert' : 'No fall detected'
    : isAlertActive ? 'Fall alert' : 'Normal walk';

  useEffect(() => {
    if (isAlertActive && !previousAlertActiveRef.current) {
      const isDemoAlert = !isDeviceConnected;
      setContactAlertStatus(isDemoAlert ? 'demo' : 'setup-required');
      setNotifications(prev => [{
        id: Date.now(),
        type: 'alert',
        title: isDemoAlert ? 'Demo: automatic contact alert' : 'Fall detected — alert service needed',
        time: 'just now',
        detail: isDemoAlert
          ? 'Would notify the primary contact. No message was sent.'
          : 'No message was sent. Configure a notification service to contact your emergency contact.',
      }, ...prev].slice(0, 4));
      addActivityLog(isDemoAlert
        ? 'Demo fall detected; contact notification simulated, not sent'
        : 'Fall detected; contact notification not sent because no alert service is configured');
    } else if (!isAlertActive && previousAlertActiveRef.current) {
      setContactAlertStatus('standby');
    }
    previousAlertActiveRef.current = isAlertActive;
  }, [isAlertActive, isDeviceConnected]);

  const tabs: { id: typeof activeTab; label: string; icon: string; badge?: string | null }[] = [
    { id: 'overview', label: 'Overview', icon: '🏠' },
    { id: 'location', label: 'Location', icon: '📍' },
    { id: 'alerts', label: 'Alerts', icon: '🚨', badge: isAlertActive ? '1' : null },
    { id: 'hardware', label: 'Hardware', icon: '🔌' },
    { id: 'activity', label: 'Activity', icon: '⚡' },
  ];
  const chartValues = [42, 58, 51, 72, 68, 83, 77, 92, 87];
  const chartMin = Math.min(...chartValues);
  const chartMax = Math.max(...chartValues);
  const chartPoints = chartValues.map((value, index) => {
    const x = index * 20;
    const y = 54 - ((value - chartMin) / (chartMax - chartMin || 1)) * 34;
    return `${x},${y}`;
  }).join(' ');
  const isDarkMode = themeMode === 'dark';

  const toggleDemoAlert = () => {
    const nextState = !demoAlertActive;
    setDemoAlertActive(nextState);
    if (!nextState) {
      setNotifications(prev => [{
        id: Date.now(),
        type: 'safe',
        title: 'Demo alert cleared',
        time: 'just now',
        detail: 'Demo status reset. No contact was notified.',
      }, ...prev].slice(0, 4));
      addActivityLog('Demo alert dismissed: user confirmed safe');
    }
  };

  const shareWebsite = async () => {
    const shareData = {
      title: 'SafeHaven · Safety dashboard',
      text: 'Explore SafeHaven, an assistive GPS and safety monitoring dashboard.',
      url: window.location.href,
    };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
        setShareFeedback('Thanks for sharing SafeHaven.');
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }

    try {
      await navigator.clipboard.writeText(shareData.url);
      setShareFeedback('Website link copied to clipboard.');
    } catch {
      setShareFeedback('Sharing is unavailable. Copy the website address from your browser.');
    }
  };

  const overviewKpis = [
    { label: 'Safety score', value: isAlertActive ? '72/100' : '96/100', tone: isAlertActive ? '#ef4444' : '#10b981', icon: '🛡️' },
    { label: 'Battery', value: `${batteryLevel ?? 82}%`, tone: '#3b82f6', icon: '🔋' },
    { label: 'GPS signal', value: hasGpsFix ? 'Locked' : 'Searching', tone: '#8b5cf6', icon: '📍' },
    { label: 'Movement', value: motionStatus, tone: isAlertActive ? '#ef4444' : '#f59e0b', icon: '⚡' },
  ];

  const incidentTimeline = [
    { time: '08:12', title: 'Fall risk spike', detail: 'High impact pattern detected', severity: 'critical' },
    { time: '08:07', title: 'GPS recovery', detail: 'Satellite lock restored', severity: 'info' },
    { time: '07:54', title: 'Battery check', detail: 'Charge remains above threshold', severity: 'ok' },
  ];

  return (
    <div style={{ minHeight: '100vh', background: isDarkMode ? 'radial-gradient(circle at top, #111827 0%, #020817 45%, #020617 100%)' : 'linear-gradient(180deg, #f8fafc 0%, #eef4ff 100%)', color: isDarkMode ? '#e2e8f0' : '#0f172a', fontFamily: 'system-ui, -apple-system, sans-serif', paddingBottom: '3rem' }}>
      <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '24px 20px 48px' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', flexWrap: 'wrap', padding: '14px 18px', borderRadius: '18px', background: isDarkMode ? 'rgba(15, 23, 42, 0.8)' : 'rgba(255,255,255,0.75)', border: isDarkMode ? '1px solid rgba(148,163,184,0.18)' : '1px solid rgba(148,163,184,0.2)', boxShadow: isDarkMode ? '0 12px 30px rgba(2,6,23,0.32)' : '0 12px 30px rgba(15,23,42,0.06)', backdropFilter: 'blur(12px)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ width: '42px', height: '42px', borderRadius: '14px', background: 'linear-gradient(135deg, #4f46e5, #7c3aed)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', boxShadow: '0 10px 22px rgba(79,70,229,0.35)' }}>🛡️</div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 800, letterSpacing: '-0.04em', color: isDarkMode ? '#f8fafc' : '#0f172a' }}>SafeHaven</h1>
                <span style={{ fontSize: '10px', background: isDeviceConnected ? '#dcfce7' : '#e0e7ff', color: isDeviceConnected ? '#15803d' : '#4f46e5', fontWeight: 700, padding: '3px 8px', borderRadius: '999px' }}>{isDeviceConnected ? 'LIVE' : 'DEMO'}</span>
              </div>
              <div style={{ fontSize: '12px', color: isDarkMode ? '#cbd5e1' : '#64748b', marginTop: '2px' }}>Command center · GPS + fall protection</div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <button type="button" onClick={shareWebsite} aria-label="Share SafeHaven website" style={{ padding: '8px 12px', borderRadius: '10px', border: isDarkMode ? '1px solid rgba(148,163,184,0.25)' : '1px solid rgba(79,70,229,0.15)', background: isDarkMode ? '#0f172a' : '#eef2ff', color: isDarkMode ? '#dbeafe' : '#312e81', fontWeight: 700, cursor: 'pointer' }}>
              ↗ Share
            </button>
            <button type="button" onClick={() => setThemeMode(prev => prev === 'dark' ? 'light' : 'dark')} style={{ padding: '8px 12px', borderRadius: '10px', border: isDarkMode ? '1px solid rgba(148,163,184,0.25)' : '1px solid rgba(79,70,229,0.15)', background: isDarkMode ? '#0f172a' : '#eef2ff', color: isDarkMode ? '#dbeafe' : '#312e81', fontWeight: 700, cursor: 'pointer' }}>
              {isDarkMode ? '☀️ Light' : '🌙 Dark'}
            </button>
            <nav style={{ display: 'flex', background: isDarkMode ? '#0f172a' : '#f1f5f9', borderRadius: '12px', padding: '4px', gap: '4px' }}>
              {tabs.map(tab => (
                <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
                  display: 'flex', alignItems: 'center', gap: '6px', padding: '9px 14px', borderRadius: '9px', background: activeTab === tab.id ? (isDarkMode ? '#111827' : '#ffffff') : 'transparent', color: activeTab === tab.id ? '#4f46e5' : (isDarkMode ? '#cbd5e1' : '#64748b'), border: 'none', fontWeight: activeTab === tab.id ? 800 : 600, cursor: 'pointer', boxShadow: activeTab === tab.id ? '0 8px 18px rgba(79,70,229,0.12)' : 'none' }}>
                  <span>{tab.icon}</span>
                  <span>{tab.label}</span>
                  {tab.badge && (
                    <span style={{ minWidth: '18px', height: '18px', borderRadius: '999px', background: '#ef4444', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 700 }}> {tab.badge} </span>
                  )}
                </button>
              ))}
            </nav>
          </div>
        </header>
        {shareFeedback && (
          <div role="status" aria-live="polite" style={{ margin: '10px 4px 0', color: isDarkMode ? '#cbd5e1' : '#475569', fontSize: '13px' }}>
            {shareFeedback}
          </div>
        )}

        <div style={{ display: 'flex', gap: '20px', marginTop: '22px', alignItems: 'flex-start' }}>
          <aside style={{ width: '270px', flexShrink: 0, background: isDarkMode ? 'rgba(15,23,42,0.9)' : '#ffffff', border: isDarkMode ? '1px solid rgba(148,163,184,0.18)' : '1px solid #e2e8f0', borderRadius: '20px', boxShadow: isDarkMode ? '0 18px 40px rgba(15,23,42,0.25)' : '0 18px 40px rgba(15,23,42,0.06)', padding: '18px', position: 'sticky', top: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', paddingBottom: '14px', borderBottom: isDarkMode ? '1px solid rgba(148,163,184,0.16)' : '1px solid #edf2f7' }}>
              <div style={{ width: '34px', height: '34px', borderRadius: '12px', background: 'linear-gradient(135deg, #4f46e5, #7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px' }}>🔔</div>
              <div>
                <div style={{ fontSize: '11px', color: isDarkMode ? '#cbd5e1' : '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800 }}>Automatic response</div>
                <div style={{ fontSize: '14px', fontWeight: 700 }}>Emergency contact alert</div>
              </div>
            </div>

            <div style={{ marginTop: '18px', display: 'grid', gap: '10px' }}>
              <div style={{ background: isDarkMode ? '#0f172a' : '#f8fafc', border: isDarkMode ? '1px solid rgba(148,163,184,0.12)' : '1px solid #e2e8f0', borderRadius: '14px', padding: '12px' }}>
                <div style={{ fontSize: '11px', color: isDarkMode ? '#cbd5e1' : '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800 }}>Fall detection</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px' }}>
                  <span style={{ fontWeight: 700 }}>{isAlertActive ? 'Fall detected' : isDeviceConnected ? 'Monitoring device' : 'Demo mode'}</span>
                  <span style={{ color: isAlertActive ? '#ef4444' : '#10b981', fontWeight: 800 }}>{isAlertActive ? 'Alert' : 'Ready'}</span>
                </div>
                <p style={{ margin: '9px 0 0', color: isDarkMode ? '#cbd5e1' : '#64748b', fontSize: '11px', lineHeight: 1.5 }}>
                  {isAlertActive
                    ? contactAlertStatus === 'demo'
                      ? 'Demo only: contact notification simulated, not sent.'
                      : 'Fall detected, but no message was sent. An alert service must be configured.'
                    : isDeviceConnected
                      ? 'Automatic notification delivery is not configured.'
                      : 'When a demo fall is triggered, the contact alert is simulated only.'}
                </p>
              </div>

              <div style={{ background: isDarkMode ? '#0f172a' : '#f8fafc', border: isDarkMode ? '1px solid rgba(148,163,184,0.12)' : '1px solid #e2e8f0', borderRadius: '14px', padding: '12px' }}>
                <div style={{ fontSize: '11px', color: isDarkMode ? '#cbd5e1' : '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800 }}>Primary contact · demo</div>
                <div style={{ marginTop: '10px', fontSize: '13px', fontWeight: 700 }}>Mom</div>
                <div style={{ marginTop: '3px', fontSize: '12px', color: isDarkMode ? '#cbd5e1' : '#64748b' }}>+60 12 345 6789</div>
                <div style={{ marginTop: '10px', padding: '8px 10px', borderRadius: '10px', background: isDarkMode ? '#111827' : '#ffffff', border: isDarkMode ? '1px solid rgba(148,163,184,0.12)' : '1px solid #e5e7eb', fontSize: '11px', color: isDarkMode ? '#cbd5e1' : '#64748b', lineHeight: 1.5 }}>
                  Demo contact details only. Configure a secure notification service before using real contacts.
                </div>
              </div>
            </div>
          </aside>

          <main style={{ flex: 1, minWidth: 0 }}>
            <section aria-label="Device connection" style={{ background: isDarkMode ? 'rgba(15,23,42,0.92)' : '#ffffff', border: isDarkMode ? '1px solid rgba(148,163,184,0.18)' : '1px solid #e2e8f0', borderRadius: '18px', padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', boxShadow: isDarkMode ? '0 12px 30px rgba(2,6,23,0.25)' : '0 12px 30px rgba(15,23,42,0.03)' }}>
              <div role="status" aria-live="polite" style={{ fontSize: '12px', color: connectionStatus === 'error' ? '#fca5a5' : isDarkMode ? '#cbd5e1' : '#475569', flex: '1 1 240px' }}>
                <strong style={{ color: isDarkMode ? '#f8fafc' : '#0f172a' }}>{connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'connecting' ? 'Connecting…' : connectionStatus === 'error' ? 'Connection failed' : 'Not connected'}</strong>
                <div style={{ marginTop: '3px' }}>{connectionError || (isDeviceConnected ? `${connectedDeviceName} · ${telemetry ? 'Receiving live sensor data' : 'Waiting for first sensor reading'}` : 'Press connect and select your ESP32 from the Bluetooth prompt.')}</div>
              </div>
              {isDeviceConnected ? (
                <button onClick={disconnectFromDevice} style={{ padding: '9px 14px', background: isDarkMode ? '#0f172a' : '#f1f5f9', border: isDarkMode ? '1px solid rgba(148,163,184,0.2)' : '1px solid #cbd5e1', borderRadius: '10px', color: isDarkMode ? '#e2e8f0' : '#334155', fontWeight: 700, cursor: 'pointer' }}>Disconnect</button>
              ) : (
                <button onClick={connectToDevice} disabled={connectionStatus === 'connecting'} style={{ padding: '9px 14px', background: 'linear-gradient(135deg, #4f46e5, #7c3aed)', border: 'none', borderRadius: '10px', color: '#ffffff', fontWeight: 700, cursor: connectionStatus === 'connecting' ? 'not-allowed' : 'pointer', opacity: connectionStatus === 'connecting' ? 0.6 : 1 }}>
                  {connectionStatus === 'connecting' ? 'Connecting…' : 'Connect device'}
                </button>
              )}
            </section>

            {activeTab === 'overview' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', marginTop: '20px' }}>
                <div style={{ background: isDarkMode ? 'rgba(15, 23, 42, 0.92)' : '#ffffff', border: isDarkMode ? '1px solid rgba(148,163,184,0.18)' : '1px solid #e2e8f0', borderRadius: '22px', padding: '22px', boxShadow: isDarkMode ? '0 18px 38px rgba(2,6,23,0.25)' : '0 18px 38px rgba(15,23,42,0.04)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
                    <div>
                      <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#4f46e5', fontWeight: 800 }}>Workspace / Summary</div>
                      <h2 style={{ margin: '8px 0 0 0', fontSize: '32px', fontWeight: 800, letterSpacing: '-0.05em', color: isDarkMode ? '#f8fafc' : '#0f172a' }}>Good morning, Demo ✨</h2>
                      <div style={{ marginTop: '8px', display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderRadius: '999px', background: isAlertActive ? '#fef2f2' : '#ecfdf5', color: isAlertActive ? '#b91c1c' : '#047857', fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{safetyStatus}</div>
                    </div>
                    {!isDeviceConnected && (
                      <button onClick={toggleDemoAlert} style={{ padding: '11px 18px', borderRadius: '12px', border: isDarkMode ? '1px solid rgba(148,163,184,0.25)' : '1px solid #e2e8f0', background: isDarkMode ? '#0f172a' : '#f8fafc', color: isDarkMode ? '#e2e8f0' : '#334155', fontWeight: 700, cursor: 'pointer' }}>{isAlertActive ? 'Clear demo alert' : 'Simulate fall alert'}</button>
                    )}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginTop: '22px' }}>
                    {overviewKpis.map(metric => (
                      <div key={metric.label} style={{ background: isDarkMode ? '#0f172a' : '#f8fafc', border: isDarkMode ? '1px solid rgba(148,163,184,0.12)' : '1px solid #e2e8f0', borderRadius: '16px', padding: '16px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                          <span style={{ fontSize: '11px', color: isDarkMode ? '#cbd5e1' : '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800 }}>{metric.label}</span>
                          <span style={{ fontSize: '18px' }}>{metric.icon}</span>
                        </div>
                        <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.05em', color: metric.tone }}>{metric.value}</div>
                      </div>
                    ))}
                  </div>

                  <div style={{ marginTop: '18px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
                    <div style={{ background: isDarkMode ? '#0f172a' : '#f8fafc', border: isDarkMode ? '1px solid rgba(148,163,184,0.12)' : '1px solid #e2e8f0', borderRadius: '16px', padding: '14px 16px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                        <span style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: isDarkMode ? '#cbd5e1' : '#94a3b8', fontWeight: 800 }}>Signal trend</span>
                        <span style={{ color: '#4f46e5', fontWeight: 700, fontSize: '12px' }}>+12%</span>
                      </div>
                      <svg viewBox="0 0 180 60" width="100%" height="60" aria-label="Signal trend chart" preserveAspectRatio="none">
                        <polyline points={chartPoints} fill="none" stroke="#4f46e5" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <div style={{ background: isDarkMode ? '#0f172a' : '#f8fafc', border: isDarkMode ? '1px solid rgba(148,163,184,0.12)' : '1px solid #e2e8f0', borderRadius: '16px', padding: '14px 16px' }}>
                      <div style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: isDarkMode ? '#cbd5e1' : '#94a3b8', fontWeight: 800, marginBottom: '10px' }}>Recent notifications</div>
                      <div style={{ display: 'grid', gap: '8px' }}>
                        {notifications.length > 0 ? notifications.map(item => (
                          <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '8px 10px', borderRadius: '10px', background: isDarkMode ? '#111827' : '#ffffff', border: isDarkMode ? '1px solid rgba(148,163,184,0.12)' : '1px solid #e5e7eb' }}>
                            <div>
                              <div style={{ fontSize: '11px', fontWeight: 700 }}>{item.title}</div>
                              <div style={{ fontSize: '10px', color: isDarkMode ? '#cbd5e1' : '#64748b', marginTop: '2px' }}>{item.detail}</div>
                            </div>
                            <span style={{ fontSize: '10px', color: isDarkMode ? '#cbd5e1' : '#64748b', whiteSpace: 'nowrap' }}>{item.time}</span>
                          </div>
                        )) : (
                          <div style={{ padding: '8px 10px', fontSize: '11px', lineHeight: 1.5, color: isDarkMode ? '#cbd5e1' : '#64748b' }}>
                            No alerts yet. Automatic contact notification is standing by.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {isAlertActive ? (
                  <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '18px', padding: '18px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div style={{ width: '42px', height: '42px', borderRadius: '12px', background: '#fee2e2', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '20px' }}>⚠️</div>
                      <div>
                        <div style={{ fontWeight: 800, color: '#7f1d1d' }}>{isDeviceConnected ? 'Device fall alert activated' : 'Demo fall alert activated'}</div>
                        <div style={{ fontSize: '12px', color: '#b91c1c' }}>{isDeviceConnected ? 'Fall detected by the connected device.' : 'This is a simulation only. No contact has been notified.'}</div>
                      </div>
                    </div>
                    {!isDeviceConnected && <button onClick={toggleDemoAlert} style={{ background: '#ffffff', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: '10px', padding: '8px 14px', fontWeight: 700, cursor: 'pointer' }}>Dismiss</button>}
                  </div>
                ) : (
                  <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: '18px', padding: '18px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div style={{ width: '42px', height: '42px', borderRadius: '12px', background: '#d1fae5', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '20px' }}>✨</div>
                      <div>
                        <div style={{ fontWeight: 800, color: '#065f46' }}>{isDeviceConnected && telemetry?.fallDetected === undefined ? 'Waiting for device status' : 'All systems normal'}</div>
                        <div style={{ fontSize: '12px', color: '#047857' }}>{isDeviceConnected ? telemetry?.fallDetected === undefined ? 'Connected, but no fall-detection reading has arrived yet.' : 'No fall detected by the connected device.' : 'Demo mode only. No real sensors are connected.'}</div>
                      </div>
                    </div>
                    {!isDeviceConnected && <button onClick={toggleDemoAlert} style={{ background: '#059669', color: '#ffffff', border: 'none', borderRadius: '10px', padding: '8px 14px', fontWeight: 700, cursor: 'pointer' }}>Simulate Fall</button>}
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
                  <div style={{ background: isDarkMode ? 'rgba(15,23,42,0.92)' : '#ffffff', border: isDarkMode ? '1px solid rgba(148,163,184,0.18)' : '1px solid #e2e8f0', borderRadius: '18px', padding: '18px', boxShadow: isDarkMode ? '0 10px 24px rgba(2,6,23,0.18)' : '0 10px 24px rgba(15,23,42,0.02)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                      <span style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: isDarkMode ? '#cbd5e1' : '#94a3b8', fontWeight: 800 }}>Location</span>
                      <span style={{ fontSize: '18px' }}>📍</span>
                    </div>
                    <div style={{ fontSize: '22px', fontWeight: 800, letterSpacing: '-0.04em', marginBottom: '10px' }}>{coordinates}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: isDarkMode ? '#cbd5e1' : '#64748b' }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: hasGpsFix ? '#10b981' : '#4f46e5' }} />
                      {isDeviceConnected ? (hasGpsFix ? 'Live GPS fix' : 'No GPS fix') : 'Demo coordinates only'}
                    </div>
                  </div>

                  <div style={{ background: isDarkMode ? 'rgba(15,23,42,0.92)' : '#ffffff', border: isDarkMode ? '1px solid rgba(148,163,184,0.18)' : '1px solid #e2e8f0', borderRadius: '18px', padding: '18px', boxShadow: isDarkMode ? '0 10px 24px rgba(2,6,23,0.18)' : '0 10px 24px rgba(15,23,42,0.02)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                      <span style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: isDarkMode ? '#cbd5e1' : '#94a3b8', fontWeight: 800 }}>Incident timeline</span>
                      <span style={{ fontSize: '18px' }}>🕒</span>
                    </div>
                    <div style={{ display: 'grid', gap: '8px' }}>
                      {incidentTimeline.map(item => (
                        <div key={item.time} style={{ display: 'flex', gap: '12px', padding: '10px 12px', borderRadius: '12px', background: isDarkMode ? '#0f172a' : '#f8fafc', border: isDarkMode ? '1px solid rgba(148,163,184,0.12)' : '1px solid #e5e7eb' }}>
                          <div style={{ width: '42px', fontSize: '11px', fontWeight: 800, color: item.severity === 'critical' ? '#ef4444' : item.severity === 'info' ? '#4f46e5' : '#10b981' }}>{item.time}</div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: '12px', fontWeight: 700 }}>{item.title}</div>
                            <div style={{ fontSize: '11px', color: isDarkMode ? '#cbd5e1' : '#64748b', marginTop: '2px' }}>{item.detail}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginTop: '2px' }}>
                  <div style={{ background: isDarkMode ? 'rgba(15,23,42,0.92)' : '#ffffff', border: isDarkMode ? '1px solid rgba(148,163,184,0.18)' : '1px solid #e2e8f0', borderRadius: '18px', padding: '18px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                      <span style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: isDarkMode ? '#cbd5e1' : '#94a3b8', fontWeight: 800 }}>Automatic response flow</span>
                      <span style={{ fontSize: '18px' }}>🚑</span>
                    </div>
                    <div style={{ display: 'grid', gap: '8px' }}>
                      {[
                        { label: 'Fall detection', status: isAlertActive ? 'Triggered' : 'Monitoring', tone: isAlertActive ? '#ef4444' : '#10b981' },
                        { label: 'GPS location', status: hasGpsFix ? 'Available' : 'Waiting', tone: hasGpsFix ? '#10b981' : '#f59e0b' },
                        { label: 'Contact notification', status: contactAlertStatus === 'demo' ? 'Simulated' : contactAlertStatus === 'setup-required' ? 'Needs service' : 'Standing by', tone: contactAlertStatus === 'demo' ? '#f59e0b' : contactAlertStatus === 'setup-required' ? '#ef4444' : '#10b981' },
                      ].map(item => (
                        <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', padding: '8px 10px', borderRadius: '10px', background: isDarkMode ? '#0f172a' : '#f8fafc', border: isDarkMode ? '1px solid rgba(148,163,184,0.12)' : '1px solid #e5e7eb' }}>
                          <span>{item.label}</span>
                          <span style={{ color: item.tone, fontWeight: 700 }}>{item.status}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{ background: isDarkMode ? 'rgba(15,23,42,0.92)' : '#ffffff', border: isDarkMode ? '1px solid rgba(148,163,184,0.18)' : '1px solid #e2e8f0', borderRadius: '18px', padding: '18px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                      <span style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: isDarkMode ? '#cbd5e1' : '#94a3b8', fontWeight: 800 }}>Emergency contacts · demo</span>
                      <span style={{ fontSize: '18px' }}>📞</span>
                    </div>
                    <div style={{ display: 'grid', gap: '8px' }}>
                      {['Mom · +60 12 345 6789', 'Clinic · +60 03 555 0101', 'Guardian · +60 19 876 5432'].map(item => (
                        <div key={item} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', borderRadius: '10px', background: isDarkMode ? '#0f172a' : '#f8fafc', border: isDarkMode ? '1px solid rgba(148,163,184,0.12)' : '1px solid #e5e7eb' }}>
                          <span style={{ fontSize: '12px', fontWeight: 700 }}>{item.split(' · ')[0]}</span>
                          <span style={{ fontSize: '11px', color: isDarkMode ? '#cbd5e1' : '#64748b' }}>{item.split(' · ')[1]}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'location' && (
              <div style={{ background: isDarkMode ? 'rgba(15,23,42,0.92)' : '#ffffff', border: isDarkMode ? '1px solid rgba(148,163,184,0.18)' : '1px solid #e2e8f0', borderRadius: '18px', padding: '24px', marginTop: '20px', boxShadow: isDarkMode ? '0 12px 30px rgba(2,6,23,0.2)' : '0 12px 30px rgba(15,23,42,0.03)' }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: '20px', fontWeight: 800 }}>Live GPS Tracking System</h3>
                <p style={{ margin: '0 0 16px 0', fontSize: '13px', color: isDarkMode ? '#cbd5e1' : '#64748b' }}>{isDeviceConnected ? 'Latest location reported by the connected ESP32:' : 'Sample location preview. Connect an ESP32 to show its GPS coordinates:'}</p>
                <div style={{ width: '100%', height: '320px', boxSizing: 'border-box', borderRadius: '14px', background: 'linear-gradient(135deg, #eef2ff, #e0e7ff)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', border: '1px solid #c7d2fe', textAlign: 'center', padding: mapEmbedUrl ? 0 : '20px' }}>
                  {mapEmbedUrl ? (
                    <iframe className="map-frame" src={mapEmbedUrl} title="Live GPS location" loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
                  ) : (
                    <>
                      <div style={{ width: '60px', height: '60px', background: '#4f46e5', color: '#fff', borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px', boxShadow: '0 10px 25px rgba(79, 70, 229, 0.4)', marginBottom: '12px' }}>🛰️</div>
                      <h4 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: '#1e293b' }}>{hasGpsFix ? 'GPS coordinates' : 'Waiting for GPS fix'}</h4>
                      <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#4f46e5', fontWeight: 700, fontFamily: 'monospace' }}>{coordinates}</p>
                      <p style={{ margin: '8px 0 0 0', fontSize: '12px', color: '#64748b' }}>{isDeviceConnected ? (hasGpsFix ? 'Location supplied by ESP32 telemetry.' : 'Waiting for GPS hardware to get a fix.') : 'Sample coordinates only; no GPS hardware is connected.'}</p>
                    </>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'alerts' && (
              <div style={{ background: isDarkMode ? 'rgba(15,23,42,0.92)' : '#ffffff', border: isDarkMode ? '1px solid rgba(148,163,184,0.18)' : '1px solid #f1f5f9', borderRadius: '18px', padding: '24px', marginTop: '20px' }}>
                <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', fontWeight: 800 }}>Automatic Safety Alerts</h3>
                <div style={{ padding: '16px', borderRadius: '12px', border: isAlertActive ? '1px solid #fecaca' : '1px solid #e2e8f0', background: isAlertActive ? '#fef2f2' : '#f8fafc', color: isAlertActive ? '#7f1d1d' : '#334155' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 800, fontSize: '14px' }}>Fall detection</span>
                    <span style={{ fontSize: '11px', opacity: 0.75, fontWeight: 700 }}>{isDeviceConnected ? 'Device status' : 'Demo status'}</span>
                  </div>
                  <p style={{ margin: '6px 0 0 0', fontSize: '12px' }}>
                    {isAlertActive ? 'Fall state detected. The dashboard warning is active.' : isDeviceConnected ? (telemetry?.fallDetected === undefined ? 'Waiting for fall-detection status from the device.' : 'No fall detected by the connected device.') : 'Demo system secure. No real sensors are connected.'}
                  </p>
                </div>
                <div style={{ marginTop: '12px', padding: '16px', borderRadius: '12px', border: isAlertActive ? '1px solid #fed7aa' : '1px solid #e2e8f0', background: isAlertActive ? '#fff7ed' : isDarkMode ? '#0f172a' : '#f8fafc', color: isDarkMode ? '#e2e8f0' : '#334155' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 800, fontSize: '14px' }}>Emergency contact notification</span>
                    <span style={{ fontSize: '11px', fontWeight: 800, color: contactAlertStatus === 'demo' ? '#b45309' : contactAlertStatus === 'setup-required' ? '#b91c1c' : '#047857' }}>
                      {contactAlertStatus === 'demo' ? 'DEMO ONLY · NOT SENT' : contactAlertStatus === 'setup-required' ? 'NOT SENT · SERVICE REQUIRED' : 'STANDING BY'}
                    </span>
                  </div>
                  <p style={{ margin: '6px 0 0', fontSize: '12px', lineHeight: 1.6, color: isDarkMode ? '#cbd5e1' : '#64748b' }}>
                    {contactAlertStatus === 'demo'
                      ? 'A fall event triggered the automatic alert flow. This is a simulation; no SMS or call was sent.'
                      : contactAlertStatus === 'setup-required'
                        ? 'The connected device reported a fall, but no SMS or call was sent. Connect a backend notification service to deliver alerts to the emergency contact.'
                        : 'When a fall is detected, the system is designed to notify the primary emergency contact automatically. Delivery needs a configured backend notification service.'}
                  </p>
                </div>
              </div>
            )}

            {activeTab === 'hardware' && (
              <section aria-labelledby="hardware-heading" style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '20px' }}>
                <div style={{ background: isDarkMode ? 'rgba(15,23,42,0.92)' : '#ffffff', border: isDarkMode ? '1px solid rgba(148,163,184,0.18)' : '1px solid #f1f5f9', borderRadius: '18px', padding: '24px' }}>
                  <h3 id="hardware-heading" style={{ margin: '0 0 6px 0', fontSize: '18px', fontWeight: 800 }}>Hardware status</h3>
                  <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.6, color: isDarkMode ? '#cbd5e1' : '#64748b' }}>
                    Live status is shown only when reported by the connected ESP32. This dashboard monitors components and does not send control commands.
                  </p>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
                  <HardwareStatusCard title="ESP32" icon="🔌" status={isDeviceConnected ? 'Connected' : connectionStatus === 'connecting' ? 'Connecting' : 'Not connected'} detail={isDeviceConnected ? connectedDeviceName : 'Connect over Bluetooth to receive hardware readings.'} active={isDeviceConnected} onConnect={connectToDevice} connectDisabled={connectionStatus === 'connecting' || isDeviceConnected} connectLabel={connectionStatus === 'connecting' ? 'Connecting…' : isDeviceConnected ? 'Connected' : 'Connect ESP32'} />
                  <HardwareStatusCard title="Motion sensor" icon="📳" status={telemetry?.accelerometer || telemetry?.gyroscope ? 'Reporting' : isDeviceConnected ? 'Not reported' : 'Not connected'} detail={[
                    telemetry?.accelerometer ? `Accel ${telemetry.accelerometer.x.toFixed(1)}, ${telemetry.accelerometer.y.toFixed(1)}, ${telemetry.accelerometer.z.toFixed(1)} m/s²` : null,
                    telemetry?.gyroscope ? `Gyro ${telemetry.gyroscope.x.toFixed(1)}, ${telemetry.gyroscope.y.toFixed(1)}, ${telemetry.gyroscope.z.toFixed(1)} °/s` : null,
                    telemetry?.fallDetected === undefined ? null : telemetry.fallDetected ? 'Fall detected' : 'No fall detected',
                  ].filter(Boolean).join(' · ') || 'Waiting for accelerometer, gyroscope, or fall-detection data.'} active={Boolean(telemetry?.accelerometer || telemetry?.gyroscope)} onConnect={connectToDevice} connectDisabled={connectionStatus === 'connecting' || isDeviceConnected} connectLabel={connectionStatus === 'connecting' ? 'Connecting…' : isDeviceConnected ? 'ESP32 connected' : 'Connect via ESP32'} />
                  <HardwareStatusCard title="Battery" icon="🔋" status={!isDeviceConnected ? 'Not connected' : telemetry?.batteryPercent === undefined ? 'Not reported' : `${telemetry.batteryPercent}%`} detail={isDeviceConnected && telemetry?.batteryPercent !== undefined ? 'Battery level reported by the device.' : 'Waiting for a battery reading.'} active={isDeviceConnected && telemetry?.batteryPercent !== undefined} onConnect={connectToDevice} connectDisabled={connectionStatus === 'connecting' || isDeviceConnected} connectLabel={connectionStatus === 'connecting' ? 'Connecting…' : isDeviceConnected ? 'ESP32 connected' : 'Connect via ESP32'} />
                  <HardwareStatusCard title="GPS module" icon="🛰️" status={gps === undefined ? isDeviceConnected ? 'Not reported' : 'Not connected' : hasGpsFix ? 'GPS fix' : 'No GPS fix'} detail={gps && hasGpsFix ? `${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)}` : 'Waiting for GPS coordinates and fix status.'} active={gps !== undefined && hasGpsFix} onConnect={connectToDevice} connectDisabled={connectionStatus === 'connecting' || isDeviceConnected} connectLabel={connectionStatus === 'connecting' ? 'Connecting…' : isDeviceConnected ? 'ESP32 connected' : 'Connect via ESP32'} />
                  <HardwareStatusCard title="GSM module" icon="📶" status={telemetry?.gsm === undefined ? isDeviceConnected ? 'Not reported' : 'Not connected' : telemetry.gsm.registered ? 'Registered' : 'Not registered'} detail={telemetry?.gsm ? [
                    telemetry.gsm.network,
                    telemetry.gsm.signalPercent === undefined ? null : `Signal ${telemetry.gsm.signalPercent}%`,
                  ].filter(Boolean).join(' · ') || 'Network status reported by device.' : 'Waiting for GSM registration and signal status.'} active={telemetry?.gsm?.registered === true} onConnect={connectToDevice} connectDisabled={connectionStatus === 'connecting' || isDeviceConnected} connectLabel={connectionStatus === 'connecting' ? 'Connecting…' : isDeviceConnected ? 'ESP32 connected' : 'Connect via ESP32'} />
                  <HardwareStatusCard title="Vibrator" icon="〰️" status={telemetry?.vibratorActive === undefined ? isDeviceConnected ? 'Not reported' : 'Not connected' : telemetry.vibratorActive ? 'Active' : 'Inactive'} detail="Read-only output status reported by the device." active={telemetry?.vibratorActive === true} onConnect={connectToDevice} connectDisabled={connectionStatus === 'connecting' || isDeviceConnected} connectLabel={connectionStatus === 'connecting' ? 'Connecting…' : isDeviceConnected ? 'ESP32 connected' : 'Connect via ESP32'} />
                  <HardwareStatusCard title="LED indicators" icon="💡" status={telemetry?.ledsActive === undefined ? isDeviceConnected ? 'Not reported' : 'Not connected' : telemetry.ledsActive ? 'Active' : 'Inactive'} detail="Read-only output status reported by the device." active={telemetry?.ledsActive === true} onConnect={connectToDevice} connectDisabled={connectionStatus === 'connecting' || isDeviceConnected} connectLabel={connectionStatus === 'connecting' ? 'Connecting…' : isDeviceConnected ? 'ESP32 connected' : 'Connect via ESP32'} />
                  <HardwareStatusCard title="Sensing electrodes" icon="〰️" status={telemetry?.electrodes === undefined ? isDeviceConnected ? 'Not reported' : 'Not connected' : telemetry.electrodes.contactDetected ? 'Contact detected' : 'No contact'} detail="Sensing input only; the dashboard does not apply electrical stimulation." active={telemetry?.electrodes?.contactDetected === true} onConnect={connectToDevice} connectDisabled={connectionStatus === 'connecting' || isDeviceConnected} connectLabel={connectionStatus === 'connecting' ? 'Connecting…' : isDeviceConnected ? 'ESP32 connected' : 'Connect via ESP32'} />
                </div>
              </section>
            )}

            {activeTab === 'activity' && (
              <div style={{ background: isDarkMode ? 'rgba(15,23,42,0.92)' : '#ffffff', border: isDarkMode ? '1px solid rgba(148,163,184,0.18)' : '1px solid #f1f5f9', borderRadius: '18px', padding: '24px', marginTop: '20px' }}>
                <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', fontWeight: 800 }}>System Activity Logs</h3>
                <div style={{ background: '#0f172a', color: '#34d399', fontFamily: 'monospace', padding: '16px', borderRadius: '12px', fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '8px', height: '260px', overflowY: 'auto' }}>
                  {activityLogs.map((log, index) => (
                    <div key={`${log}-${index}`} style={{ display: 'flex', gap: '8px' }}>
                      <span style={{ color: '#64748b' }}>&gt;</span>
                      <span>{log}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function HardwareStatusCard({
  title,
  icon,
  status,
  detail,
  active,
  onConnect,
  connectDisabled,
  connectLabel,
}: {
  title: string
  icon: string
  status: string
  detail: string
  active: boolean
  onConnect: () => void
  connectDisabled: boolean
  connectLabel: string
}) {
  return (
    <article style={{ background: '#ffffff', padding: '18px', borderRadius: '14px', border: '1px solid #e2e8f0', boxShadow: '0 4px 16px rgba(0,0,0,0.02)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
        <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 800, color: '#0f172a' }}>{icon} {title}</h4>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: 700, color: active ? '#047857' : '#64748b', whiteSpace: 'nowrap' }}>
          <span aria-hidden="true" style={{ width: '7px', height: '7px', borderRadius: '50%', background: active ? '#10b981' : '#94a3b8' }} />
          {status}
        </span>
      </div>
      <p style={{ margin: '10px 0 12px 0', fontSize: '12px', lineHeight: 1.5, color: '#64748b', overflowWrap: 'anywhere' }}>{detail}</p>
      <button
        type="button"
        onClick={onConnect}
        disabled={connectDisabled}
        style={{
          padding: '7px 10px',
          border: '1px solid #c7d2fe',
          borderRadius: '8px',
          background: connectDisabled ? '#f8fafc' : '#eef2ff',
          color: connectDisabled ? '#64748b' : '#4338ca',
          fontSize: '11px',
          fontWeight: 700,
          cursor: connectDisabled ? 'not-allowed' : 'pointer',
        }}
      >
        {connectLabel}
      </button>
    </article>
  )
}
