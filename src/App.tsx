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
  const [activeTab, setActiveTab] = useState<'overview' | 'location' | 'alerts' | 'hardware'>('overview');
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>('light');
  const [telemetry, setTelemetry] = useState<DeviceTelemetry | null>(null);
  const [browserLocation, setBrowserLocation] = useState<GeolocationPosition | null>(null);
  const [browserLocationWatching, setBrowserLocationWatching] = useState(false);
  const [browserLocationError, setBrowserLocationError] = useState('');
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
  const previousObstacleDetectedRef = useRef(false);
  const lineBufferRef = useRef('');
  const decoderRef = useRef(new TextDecoder());
  const locationWatchIdRef = useRef<number | null>(null);
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
      if (locationWatchIdRef.current !== null) {
        navigator.geolocation.clearWatch(locationWatchIdRef.current);
      }
    };
  }, []);

  const startBrowserLocation = () => {
    if (!navigator.geolocation) {
      setBrowserLocationError('Live browser location is not supported by this browser.');
      return;
    }

    setBrowserLocationError('');
    if (locationWatchIdRef.current !== null) {
      navigator.geolocation.clearWatch(locationWatchIdRef.current);
      locationWatchIdRef.current = null;
    }
    const watchId = navigator.geolocation.watchPosition(
      position => {
        setBrowserLocation(position);
        setBrowserLocationWatching(true);
        setBrowserLocationError('');
      },
      error => {
        const message = error.code === error.PERMISSION_DENIED
          ? 'Location permission was denied. Allow location access in your browser to use live browser location.'
          : error.code === error.POSITION_UNAVAILABLE
            ? 'The browser could not determine your current location.'
            : 'Timed out while requesting your current location.';
        setBrowserLocationError(message);
        setBrowserLocation(null);
        setBrowserLocationWatching(false);
        if (locationWatchIdRef.current !== null) {
          navigator.geolocation.clearWatch(locationWatchIdRef.current);
          locationWatchIdRef.current = null;
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
    locationWatchIdRef.current = watchId;
    setBrowserLocationWatching(true);
  };

  const stopBrowserLocation = () => {
    if (locationWatchIdRef.current !== null) {
      navigator.geolocation.clearWatch(locationWatchIdRef.current);
      locationWatchIdRef.current = null;
    }
    setBrowserLocationWatching(false);
    setBrowserLocation(null);
  };

  const addObstacleNotification = () => {
    const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setNotifications(prev => [{
      id: Date.now(),
      type: 'obstacle',
      title: 'Obstacle detected · local notification',
      time: timeNow,
      detail: 'Dashboard notification only. No SMS or emergency contact message was sent.',
    }, ...prev].slice(0, 4));
  };

  const connectToDevice = async () => {
    if (connectInProgressRef.current) return;
    connectInProgressRef.current = true;
    setConnectionError('');
    setConnectionStatus('connecting');
    setTelemetry(null);
    previousObstacleDetectedRef.current = false;
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
          return;
        }

        const lines = lineBufferRef.current.split('\n');
        lineBufferRef.current = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const nextTelemetry = parseDeviceMessage(line.trim());
            if (nextTelemetry.obstacleDetected !== undefined) {
              if (nextTelemetry.obstacleDetected && !previousObstacleDetectedRef.current) {
                addObstacleNotification();
              }
              previousObstacleDetectedRef.current = nextTelemetry.obstacleDetected;
            }
            setTelemetry(previous => {
              const gps = nextTelemetry.gps
                ? { ...nextTelemetry.gps, fix: nextTelemetry.gps.fix ?? previous?.gps?.fix }
                : previous?.gps;
              const gsm = nextTelemetry.gsm
                ? {
                    ...nextTelemetry.gsm,
                    signalPercent: nextTelemetry.gsm.signalPercent ?? previous?.gsm?.signalPercent,
                    network: nextTelemetry.gsm.network ?? previous?.gsm?.network,
                  }
                : previous?.gsm;
              const electrodes = nextTelemetry.electrodes ?? previous?.electrodes;

              return {
                ...previous,
                ...nextTelemetry,
                ...(gps ? { gps } : {}),
                ...(gsm ? { gsm } : {}),
                ...(electrodes ? { electrodes } : {}),
              };
            });
            setConnectionError('');
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Invalid device message';
            setConnectionError(message);
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
        previousObstacleDetectedRef.current = false;
        setConnectionStatus('disconnected');
        setConnectedDeviceName('');
        setTelemetry(null);
        setConnectionError('');
      };
      disconnectListenerRef.current = disconnectListener;
      device.addEventListener('gattserverdisconnected', disconnectListener);

      await characteristic.startNotifications();
      setConnectedDeviceName(device.name || 'ESP32 device');
      setConnectionStatus('connected');
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
    previousObstacleDetectedRef.current = false;
    device?.gatt?.disconnect();
    setTelemetry(null);
    setConnectedDeviceName('');
    setConnectionStatus('disconnected');
    setConnectionError('');
  };

  const isDeviceConnected = connectionStatus === 'connected';
  const isAlertActive = isDeviceConnected && telemetry?.fallDetected === true;
  const contactAlertStatus = isAlertActive ? 'setup-required' : 'standby';
  const gps = isDeviceConnected
    ? telemetry?.gps
    : browserLocation
      ? { latitude: browserLocation.coords.latitude, longitude: browserLocation.coords.longitude, fix: true }
      : undefined;
  const hasGpsFix = gps !== undefined && gps.fix !== false;
  const hasMotionData = Boolean(telemetry?.accelerometer || telemetry?.gyroscope);
  const mapLocation = gps && hasGpsFix ? gps : null;
  const mapsApiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  const mapEmbedUrl = mapsApiKey && mapLocation
    ? `https://www.google.com/maps/embed/v1/view?key=${encodeURIComponent(mapsApiKey)}&center=${mapLocation.latitude},${mapLocation.longitude}&zoom=16`
    : null;
  const coordinates = gps && hasGpsFix
    ? `${gps.latitude.toFixed(4)}°, ${gps.longitude.toFixed(4)}°`
    : isDeviceConnected ? 'Waiting for GPS fix' : browserLocationWatching ? 'Waiting for location fix' : 'Live location not started';
  const fallStatus = isDeviceConnected
    ? telemetry?.fallDetected === undefined
      ? 'Waiting for fall status'
      : isAlertActive ? 'Fall detected' : 'No fall detected'
    : 'Waiting for device data';
  const gpsStatus = isDeviceConnected
    ? gps === undefined ? 'Not reported' : hasGpsFix ? 'GPS fix' : 'No fix'
    : browserLocation ? 'Browser location fix' : browserLocationWatching ? 'Waiting for location fix' : 'Not started';
  const motionStatus = isDeviceConnected
    ? hasMotionData ? 'Motion data received' : 'Not reported'
    : 'Not connected';

  useEffect(() => {
    if (isAlertActive) {
      if (!previousAlertActiveRef.current) {
        const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        setNotifications(prev => [{
          id: Date.now(),
          type: 'alert',
          title: 'Fall detected · message not sent',
          time: timeNow,
          detail: 'No SMS or call service is configured; no message was sent.',
        }, ...prev].slice(0, 4));
      }
    }
    previousAlertActiveRef.current = isAlertActive;
  }, [isAlertActive, isDeviceConnected]);

  const tabs: { id: typeof activeTab; label: string; icon: string; badge?: string | null }[] = [
    { id: 'overview', label: 'Overview', icon: '🏠' },
    { id: 'location', label: 'Location', icon: '📍' },
    { id: 'alerts', label: 'Alerts', icon: '🚨', badge: isAlertActive || telemetry?.obstacleDetected ? '1' : null },
    { id: 'hardware', label: 'Hardware', icon: '🔌' },
  ];
  const isDarkMode = themeMode === 'dark';

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
    { label: 'Fall detection', value: fallStatus, tone: isAlertActive ? '#dc2626' : isDeviceConnected && telemetry?.fallDetected === false ? '#059669' : '#4f46e5', icon: '🛡️' },
    { label: 'GPS', value: gpsStatus, tone: '#8b5cf6', icon: '📍' },
    { label: 'Motion', value: motionStatus, tone: '#f59e0b', icon: '⚡' },
  ];
  const incidentTimeline = notifications.slice(0, 3);

  return (
    <div data-theme={isDarkMode ? 'dark' : 'light'} style={{ minHeight: '100vh', background: isDarkMode ? 'radial-gradient(circle at top, #111827 0%, #020817 45%, #020617 100%)' : 'linear-gradient(180deg, #f8fafc 0%, #eef4ff 100%)', color: isDarkMode ? '#e2e8f0' : '#0f172a', fontFamily: 'system-ui, -apple-system, sans-serif', paddingBottom: '3rem' }}>
      <div className="app-shell" style={{ maxWidth: '1400px', margin: '0 auto', padding: '24px 20px 48px' }}>
        <header className="app-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', flexWrap: 'wrap', padding: '14px 18px', borderRadius: '18px', background: isDarkMode ? 'rgba(15, 23, 42, 0.8)' : 'rgba(255,255,255,0.75)', border: isDarkMode ? '1px solid rgba(148,163,184,0.18)' : '1px solid rgba(148,163,184,0.2)', boxShadow: isDarkMode ? '0 12px 30px rgba(2,6,23,0.32)' : '0 12px 30px rgba(15,23,42,0.06)', backdropFilter: 'blur(12px)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ width: '42px', height: '42px', borderRadius: '14px', background: 'linear-gradient(135deg, #4f46e5, #7c3aed)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', boxShadow: '0 10px 22px rgba(79,70,229,0.35)' }}>🛡️</div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 800, letterSpacing: '-0.04em', color: isDarkMode ? '#f8fafc' : '#0f172a' }}>SafeHaven</h1>
                <span style={{ fontSize: '10px', background: isDeviceConnected ? '#dcfce7' : '#e0e7ff', color: isDeviceConnected ? '#15803d' : '#4f46e5', fontWeight: 700, padding: '3px 8px', borderRadius: '999px' }}>{isDeviceConnected ? 'DEVICE LIVE' : 'WAITING FOR DATA'}</span>
              </div>
              <div style={{ fontSize: '12px', color: isDarkMode ? '#cbd5e1' : '#64748b', marginTop: '2px' }}>Command center · GPS + fall protection</div>
            </div>
          </div>

          <div className="app-header-controls" style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <button type="button" onClick={shareWebsite} aria-label="Share SafeHaven website" style={{ padding: '8px 12px', borderRadius: '10px', border: isDarkMode ? '1px solid rgba(148,163,184,0.25)' : '1px solid rgba(79,70,229,0.15)', background: isDarkMode ? '#0f172a' : '#eef2ff', color: isDarkMode ? '#dbeafe' : '#312e81', fontWeight: 700, cursor: 'pointer' }}>
              ↗ Share
            </button>
            <button type="button" onClick={() => setThemeMode(prev => prev === 'dark' ? 'light' : 'dark')} style={{ padding: '8px 12px', borderRadius: '10px', border: isDarkMode ? '1px solid rgba(148,163,184,0.25)' : '1px solid rgba(79,70,229,0.15)', background: isDarkMode ? '#0f172a' : '#eef2ff', color: isDarkMode ? '#dbeafe' : '#312e81', fontWeight: 700, cursor: 'pointer' }}>
              {isDarkMode ? '☀️ Light' : '🌙 Dark'}
            </button>
            <nav className="app-navigation" aria-label="Dashboard sections" style={{ display: 'flex', background: isDarkMode ? '#0f172a' : '#f1f5f9', borderRadius: '12px', padding: '4px', gap: '4px' }}>
              {tabs.map(tab => (
                <button key={tab.id} type="button" aria-current={activeTab === tab.id ? 'page' : undefined} onClick={() => setActiveTab(tab.id)} style={{
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

        <div className="app-dashboard-layout" style={{ display: 'flex', gap: '20px', marginTop: '22px', alignItems: 'flex-start' }}>
          <aside className="app-dashboard-sidebar" style={{ width: '270px', flexShrink: 0, background: isDarkMode ? 'rgba(15,23,42,0.9)' : '#ffffff', border: isDarkMode ? '1px solid rgba(148,163,184,0.18)' : '1px solid #e2e8f0', borderRadius: '20px', boxShadow: isDarkMode ? '0 18px 40px rgba(15,23,42,0.25)' : '0 18px 40px rgba(15,23,42,0.06)', padding: '18px', position: 'sticky', top: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', paddingBottom: '14px', borderBottom: isDarkMode ? '1px solid rgba(148,163,184,0.16)' : '1px solid #edf2f7' }}>
              <div style={{ width: '34px', height: '34px', borderRadius: '12px', background: 'linear-gradient(135deg, #4f46e5, #7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px' }}>🔔</div>
              <div>
                <div style={{ fontSize: '11px', color: isDarkMode ? '#cbd5e1' : '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800 }}>Notification delivery</div>
                <div style={{ fontSize: '14px', fontWeight: 700 }}>Local dashboard only</div>
              </div>
            </div>

            <div style={{ marginTop: '18px', display: 'grid', gap: '10px' }}>
              <div style={{ background: isDarkMode ? '#0f172a' : '#f8fafc', border: isDarkMode ? '1px solid rgba(148,163,184,0.12)' : '1px solid #e2e8f0', borderRadius: '14px', padding: '12px' }}>
                <div style={{ fontSize: '11px', color: isDarkMode ? '#cbd5e1' : '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800 }}>Fall detection</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px' }}>
                  <span style={{ fontWeight: 700 }}>{isAlertActive ? 'Fall detected' : isDeviceConnected && telemetry?.fallDetected === false ? 'No fall reported' : 'Waiting for device data'}</span>
                  <span style={{ color: isAlertActive ? '#ef4444' : isDeviceConnected && telemetry?.fallDetected === false ? '#10b981' : '#64748b', fontWeight: 800 }}>{isAlertActive ? 'Alert' : isDeviceConnected && telemetry?.fallDetected === false ? 'Clear' : 'Unknown'}</span>
                </div>
                <p style={{ margin: '9px 0 0', color: isDarkMode ? '#cbd5e1' : '#64748b', fontSize: '11px', lineHeight: 1.5 }}>
                  {isAlertActive
                    ? 'Fall detected by the device. No SMS or call service is configured.'
                    : isDeviceConnected
                      ? telemetry?.fallDetected === undefined
                        ? 'Waiting for fall-detection data from the device.'
                        : 'No fall is currently reported. Contact delivery is not configured.'
                      : 'Connect an ESP32 to receive live fall-detection readings.'}
                </p>
              </div>

              <div style={{ background: isDarkMode ? '#0f172a' : '#f8fafc', border: isDarkMode ? '1px solid rgba(148,163,184,0.12)' : '1px solid #e2e8f0', borderRadius: '14px', padding: '12px' }}>
                <div style={{ fontSize: '11px', color: isDarkMode ? '#cbd5e1' : '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800 }}>Emergency contacts</div>
                <div style={{ display: 'grid', gap: '8px', marginTop: '10px' }}>
                  {['Primary contact', 'Backup contact'].map(contact => (
                    <div key={contact} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', padding: '8px 10px', borderRadius: '10px', background: isDarkMode ? '#111827' : '#ffffff', border: isDarkMode ? '1px solid rgba(148,163,184,0.12)' : '1px solid #e5e7eb', fontSize: '11px' }}>
                      <span style={{ fontWeight: 700 }}>{contact}</span>
                      <span style={{ color: isDarkMode ? '#cbd5e1' : '#64748b' }}>Not configured</span>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: '10px', fontSize: '11px', color: isDarkMode ? '#cbd5e1' : '#64748b', lineHeight: 1.5 }}>
                  No contact or SMS/call service is configured. Alerts stay on this dashboard.
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
                      <h2 style={{ margin: '8px 0 0 0', fontSize: '32px', fontWeight: 800, letterSpacing: '-0.05em', color: isDarkMode ? '#f8fafc' : '#0f172a' }}>Safety overview</h2>
                      <div style={{ marginTop: '8px', display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderRadius: '999px', background: isAlertActive ? '#fef2f2' : isDeviceConnected && telemetry?.fallDetected === false ? '#ecfdf5' : isDarkMode ? '#1e1b4b' : '#eef2ff', color: isAlertActive ? '#b91c1c' : isDeviceConnected && telemetry?.fallDetected === false ? '#047857' : '#4338ca', fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{fallStatus}</div>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginTop: '22px' }}>
                    {overviewKpis.map(metric => (
                      <div key={metric.label} style={{ background: isDarkMode ? '#0f172a' : '#f8fafc', border: isDarkMode ? '1px solid rgba(148,163,184,0.12)' : '1px solid #e2e8f0', borderRadius: '16px', padding: '16px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                          <span style={{ fontSize: '11px', color: isDarkMode ? '#cbd5e1' : '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800 }}>{metric.label}</span>
                          <span style={{ fontSize: '18px' }}>{metric.icon}</span>
                        </div>
                        <div style={{ fontSize: metric.value.length > 15 ? '17px' : '24px', fontWeight: 800, letterSpacing: '-0.04em', lineHeight: 1.25, overflowWrap: 'anywhere', color: metric.tone }}>{metric.value}</div>
                      </div>
                    ))}
                  </div>

                  <div style={{ marginTop: '18px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
                    <div style={{ background: isDarkMode ? '#0f172a' : '#f8fafc', border: isDarkMode ? '1px solid rgba(148,163,184,0.12)' : '1px solid #e2e8f0', borderRadius: '16px', padding: '14px 16px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                        <span style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: isDarkMode ? '#cbd5e1' : '#94a3b8', fontWeight: 800 }}>Incident timeline</span>
                        <span style={{ fontSize: '18px' }}>🕒</span>
                      </div>
                      <div style={{ display: 'grid', gap: '8px' }}>
                        {incidentTimeline.length > 0
                          ? incidentTimeline.map(item => (
                            <div key={item.id} style={{ display: 'flex', gap: '12px', padding: '10px 12px', borderRadius: '12px', background: isDarkMode ? '#111827' : '#ffffff', border: isDarkMode ? '1px solid rgba(148,163,184,0.12)' : '1px solid #e5e7eb' }}>
                              <div style={{ width: '42px', fontSize: '11px', fontWeight: 800, color: 'type' in item && item.type === 'alert' ? '#ef4444' : '#b45309' }}>{item.time}</div>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: '12px', fontWeight: 700 }}>{item.title}</div>
                                <div style={{ fontSize: '11px', color: isDarkMode ? '#cbd5e1' : '#64748b', marginTop: '2px' }}>{item.detail}</div>
                              </div>
                            </div>
                          ))
                          : <div style={{ padding: '10px 12px', borderRadius: '12px', background: isDarkMode ? '#111827' : '#ffffff', color: isDarkMode ? '#cbd5e1' : '#64748b', fontSize: '12px', lineHeight: 1.5 }}>No live incidents have been reported in this session.</div>}
                      </div>
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
                            No alerts yet. Local dashboard notifications are ready; emergency contact delivery requires a configured service.
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
                        <div style={{ fontWeight: 800, color: '#7f1d1d' }}>Device fall alert activated</div>
                        <div style={{ fontSize: '12px', color: '#b91c1c' }}>Fall detected by the connected device.</div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ background: isDeviceConnected && telemetry?.fallDetected === false ? '#ecfdf5' : isDarkMode ? '#0f172a' : '#eef2ff', border: isDeviceConnected && telemetry?.fallDetected === false ? '1px solid #a7f3d0' : '1px solid #c7d2fe', borderRadius: '18px', padding: '18px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div style={{ width: '42px', height: '42px', borderRadius: '12px', background: isDeviceConnected && telemetry?.fallDetected === false ? '#d1fae5' : '#e0e7ff', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '20px' }}>🛡️</div>
                      <div>
                        <div style={{ fontWeight: 800, color: isDeviceConnected && telemetry?.fallDetected === false ? '#065f46' : isDarkMode ? '#e2e8f0' : '#312e81' }}>{isDeviceConnected && telemetry?.fallDetected === false ? 'No fall detected' : 'Waiting for device data'}</div>
                        <div style={{ fontSize: '12px', color: isDeviceConnected && telemetry?.fallDetected === false ? '#047857' : isDarkMode ? '#cbd5e1' : '#4338ca' }}>{isDeviceConnected && telemetry?.fallDetected === false ? 'The connected device currently reports no fall.' : isDeviceConnected ? 'Connected, but no fall-detection reading has arrived yet.' : 'Connect the ESP32 to receive fall-detection readings.'}</div>
                      </div>
                    </div>
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
                      {isDeviceConnected ? (hasGpsFix ? 'Live ESP32 GPS fix' : 'No GPS fix') : browserLocation ? 'Live browser location' : browserLocationWatching ? 'Waiting for browser location' : 'Location not started'}
                    </div>
                  </div>

                </div>
              </div>
            )}

            {activeTab === 'location' && (
              <div style={{ background: isDarkMode ? 'rgba(15,23,42,0.92)' : '#ffffff', border: isDarkMode ? '1px solid rgba(148,163,184,0.18)' : '1px solid #e2e8f0', borderRadius: '18px', padding: '24px', marginTop: '20px', boxShadow: isDarkMode ? '0 12px 30px rgba(2,6,23,0.2)' : '0 12px 30px rgba(15,23,42,0.03)' }}>
                <h3 style={{ margin: '0 0 8px 0', fontSize: '20px', fontWeight: 800 }}>Device location</h3>
                <p style={{ margin: '0 0 16px 0', fontSize: '13px', color: isDarkMode ? '#cbd5e1' : '#64748b' }}>{isDeviceConnected ? 'Latest live location reported by the connected ESP32:' : 'Start live browser location or connect an ESP32 GPS module. Browser location requires your permission.'}</p>
                {!isDeviceConnected && (
                  <button type="button" onClick={browserLocationWatching ? stopBrowserLocation : startBrowserLocation} style={{ marginBottom: '12px', padding: '9px 14px', background: browserLocationWatching ? (isDarkMode ? '#0f172a' : '#f1f5f9') : 'linear-gradient(135deg, #4f46e5, #7c3aed)', border: browserLocationWatching ? '1px solid #cbd5e1' : 'none', borderRadius: '10px', color: browserLocationWatching ? (isDarkMode ? '#e2e8f0' : '#334155') : '#ffffff', fontWeight: 700, cursor: 'pointer' }}>
                    {browserLocationWatching ? 'Stop live browser location' : 'Start live browser location'}
                  </button>
                )}
                {browserLocationError && <p role="alert" style={{ margin: '0 0 12px 0', color: '#dc2626', fontSize: '12px' }}>{browserLocationError}</p>}
                {browserLocation && !isDeviceConnected && <p style={{ margin: '0 0 12px 0', fontSize: '12px', color: isDarkMode ? '#cbd5e1' : '#64748b' }}>Accuracy: {Math.round(browserLocation.coords.accuracy)} m · updated {new Date(browserLocation.timestamp).toLocaleTimeString()}</p>}
                <div style={{ width: '100%', height: '320px', boxSizing: 'border-box', borderRadius: '14px', background: 'linear-gradient(135deg, #eef2ff, #e0e7ff)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', border: '1px solid #c7d2fe', textAlign: 'center', padding: mapEmbedUrl ? 0 : '20px' }}>
                  {mapEmbedUrl ? (
                    <iframe className="map-frame" src={mapEmbedUrl} title="Live GPS location" loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
                  ) : (
                    <>
                      <div style={{ width: '60px', height: '60px', background: '#4f46e5', color: '#fff', borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px', boxShadow: '0 10px 25px rgba(79, 70, 229, 0.4)', marginBottom: '12px' }}>🛰️</div>
                      <h4 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: '#1e293b' }}>{hasGpsFix ? 'Live location coordinates' : 'Waiting for a live location fix'}</h4>
                      <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#4f46e5', fontWeight: 700, fontFamily: 'monospace' }}>{coordinates}</p>
                      <p style={{ margin: '8px 0 0 0', fontSize: '12px', color: '#64748b' }}>{isDeviceConnected ? (hasGpsFix ? 'Location supplied by live ESP32 telemetry.' : 'Waiting for GPS hardware to get a fix.') : browserLocation ? 'Location supplied by your browser after permission was granted.' : browserLocationError || 'No live location has been requested or received.'}</p>
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
                    <span style={{ fontSize: '11px', opacity: 0.75, fontWeight: 700 }}>{isDeviceConnected ? 'Device status' : 'Waiting for device data'}</span>
                  </div>
                  <p style={{ margin: '6px 0 0 0', fontSize: '12px' }}>
                    {isAlertActive ? 'Fall state detected. The dashboard warning is active.' : isDeviceConnected ? (telemetry?.fallDetected === undefined ? 'Waiting for fall-detection status from the device.' : 'The device currently reports no fall.') : 'Connect the ESP32 to receive live fall-detection readings.'}
                  </p>
                </div>
                <div style={{ marginTop: '12px', padding: '16px', borderRadius: '12px', border: isDeviceConnected && telemetry?.obstacleDetected ? '1px solid #fed7aa' : '1px solid #e2e8f0', background: isDeviceConnected && telemetry?.obstacleDetected ? '#fff7ed' : isDarkMode ? '#0f172a' : '#f8fafc', color: isDarkMode ? '#e2e8f0' : '#334155' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 800, fontSize: '14px' }}>Obstacle detection</span>
                    <span style={{ fontSize: '11px', fontWeight: 800, color: isDeviceConnected && telemetry?.obstacleDetected ? '#b45309' : '#64748b' }}>
                      {isDeviceConnected && telemetry?.obstacleDetected ? 'DETECTED · LOCAL NOTIFICATION' : isDeviceConnected && telemetry?.obstacleDetected === false ? 'CLEAR' : 'WAITING FOR SENSOR'}
                    </span>
                  </div>
                  <p style={{ margin: '6px 0 0', fontSize: '12px', lineHeight: 1.6, color: isDarkMode ? '#cbd5e1' : '#64748b' }}>
                    {isDeviceConnected && telemetry?.obstacleDetected
                      ? 'An in-dashboard notification was created. No SMS or emergency contact message was sent.'
                      : isDeviceConnected && telemetry?.obstacleDetected === false
                        ? 'The connected device reports no obstacle. A new detection will create another local notification.'
                        : 'Waiting for obstacleDetected status from the connected ESP32.'}
                  </p>
                </div>
                <div style={{ marginTop: '12px', padding: '16px', borderRadius: '12px', border: isAlertActive ? '1px solid #fed7aa' : '1px solid #e2e8f0', background: isAlertActive ? '#fff7ed' : isDarkMode ? '#0f172a' : '#f8fafc', color: isDarkMode ? '#e2e8f0' : '#334155' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 800, fontSize: '14px' }}>Emergency contact notification</span>
                    <span style={{ fontSize: '11px', fontWeight: 800, color: contactAlertStatus === 'setup-required' ? '#b91c1c' : '#64748b' }}>
                      {contactAlertStatus === 'setup-required' ? 'NOT SENT · SERVICE REQUIRED' : 'NOT CONFIGURED'}
                    </span>
                  </div>
                  <p style={{ margin: '6px 0 0', fontSize: '12px', lineHeight: 1.6, color: isDarkMode ? '#cbd5e1' : '#64748b' }}>
                    {contactAlertStatus === 'setup-required'
                        ? 'The connected device reported a fall, but no SMS or call was sent. Connect a backend notification service to deliver alerts to the emergency contact.'
                        : 'No recipient or message-delivery service is configured. Alerts appear on this dashboard only; no SMS or call will be sent.'}
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
                  <HardwareStatusCard title="Motion sensor" icon="📳" status={hasMotionData || telemetry?.fallDetected !== undefined ? 'Reporting' : isDeviceConnected ? 'Not reported' : 'Not connected'} detail={[
                    telemetry?.accelerometer ? `Accel ${telemetry.accelerometer.x.toFixed(1)}, ${telemetry.accelerometer.y.toFixed(1)}, ${telemetry.accelerometer.z.toFixed(1)} m/s²` : null,
                    telemetry?.gyroscope ? `Gyro ${telemetry.gyroscope.x.toFixed(1)}, ${telemetry.gyroscope.y.toFixed(1)}, ${telemetry.gyroscope.z.toFixed(1)} °/s` : null,
                    telemetry?.fallDetected === undefined ? null : telemetry.fallDetected ? 'Fall detected' : 'No fall detected',
                  ].filter(Boolean).join(' · ') || 'Waiting for accelerometer, gyroscope, or fall-detection data.'} active={hasMotionData || telemetry?.fallDetected !== undefined} onConnect={connectToDevice} connectDisabled={connectionStatus === 'connecting' || isDeviceConnected} connectLabel={connectionStatus === 'connecting' ? 'Connecting…' : isDeviceConnected ? 'ESP32 connected' : 'Connect via ESP32'} />
                  <HardwareStatusCard title="Obstacle sensor" icon="🚧" status={telemetry?.obstacleDetected === undefined ? isDeviceConnected ? 'Not reported' : 'Not connected' : telemetry.obstacleDetected ? 'Obstacle detected' : 'Clear'} detail={telemetry?.obstacleDetected === true ? 'Detection reported by the device; a local dashboard notification was created.' : telemetry?.obstacleDetected === false ? 'No obstacle reported by the device.' : isDeviceConnected ? 'Waiting for obstacle-detection status.' : 'Connect the ESP32 to receive obstacle-detection status.'} active={telemetry?.obstacleDetected === true} onConnect={connectToDevice} connectDisabled={connectionStatus === 'connecting' || isDeviceConnected} connectLabel={connectionStatus === 'connecting' ? 'Connecting…' : isDeviceConnected ? 'ESP32 connected' : 'Connect via ESP32'} />
                  <HardwareStatusCard title="GPS module" icon="🛰️" status={telemetry?.gps === undefined ? isDeviceConnected ? 'Not reported' : 'Not connected' : hasGpsFix ? 'GPS fix' : 'No GPS fix'} detail={telemetry?.gps && hasGpsFix ? `${telemetry.gps.latitude.toFixed(6)}, ${telemetry.gps.longitude.toFixed(6)}` : isDeviceConnected ? 'Waiting for GPS coordinates and fix status.' : 'Connect the ESP32 to receive GPS status.'} active={isDeviceConnected && telemetry?.gps !== undefined && hasGpsFix} onConnect={connectToDevice} connectDisabled={connectionStatus === 'connecting' || isDeviceConnected} connectLabel={connectionStatus === 'connecting' ? 'Connecting…' : isDeviceConnected ? 'ESP32 connected' : 'Connect via ESP32'} />
                  <HardwareStatusCard title="LED indicators" icon="💡" status={telemetry?.ledsActive === undefined ? isDeviceConnected ? 'Not reported' : 'Not connected' : telemetry.ledsActive ? 'Active' : 'Inactive'} detail={isDeviceConnected && telemetry?.ledsActive !== undefined ? 'Read-only output status reported by the device.' : isDeviceConnected ? 'Waiting for LED status.' : 'Connect the ESP32 to receive LED status.'} active={telemetry?.ledsActive === true} onConnect={connectToDevice} connectDisabled={connectionStatus === 'connecting' || isDeviceConnected} connectLabel={connectionStatus === 'connecting' ? 'Connecting…' : isDeviceConnected ? 'ESP32 connected' : 'Connect via ESP32'} />
                </div>
              </section>
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
    <article className="hardware-status-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
        <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 800 }}>{icon} {title}</h4>
        <span data-active={active} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap' }}>
          <span className="hardware-status-dot" aria-hidden="true" />
          {status}
        </span>
      </div>
      <p style={{ margin: '10px 0 12px 0', fontSize: '12px', lineHeight: 1.5, overflowWrap: 'anywhere' }}>{detail}</p>
      <button
        type="button"
        className="hardware-connect-button"
        onClick={onConnect}
        disabled={connectDisabled}
      >
        {connectLabel}
      </button>
    </article>
  )
}
