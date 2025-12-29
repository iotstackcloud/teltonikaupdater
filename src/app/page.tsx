'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

interface Router {
  id: string;
  device_name: string;
  ip_address: string;
  username: string | null;
  password: string | null;
  current_firmware: string | null;
  available_firmware: string | null;
  last_check: string | null;
  status: string;
}

interface BatchJob {
  id: string;
  status: string;
  batch_size: number;
  total_routers: number;
  completed_routers: number;
  failed_routers: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface UpdateHistory {
  id: string;
  router_id: string;
  device_name: string;
  ip_address: string;
  firmware_before: string | null;
  firmware_after: string | null;
  status: string;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface LiveEvent {
  id: string;
  type: string;
  timestamp: string;
  message: string;
  level: 'info' | 'success' | 'warning' | 'error';
}

interface FirmwareVersion {
  device_prefix: string;
  latest_version: string;
  updated_at: string;
}

export default function Home() {
  const [routers, setRouters] = useState<Router[]>([]);
  const [stats, setStats] = useState<{ status: string; count: number }[]>([]);
  const [activeJob, setActiveJob] = useState<BatchJob | null>(null);
  const [history, setHistory] = useState<UpdateHistory[]>([]);
  const [selectedRouters, setSelectedRouters] = useState<Set<string>>(new Set());
  const [batchSize, setBatchSize] = useState(5);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Live events state
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const [progress, setProgress] = useState<{ completed: number; failed: number; total: number; percent: number } | null>(null);
  const [waitingTime, setWaitingTime] = useState<number | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Settings state
  const [globalUsername, setGlobalUsername] = useState('');
  const [globalPassword, setGlobalPassword] = useState('');
  const [hasGlobalCreds, setHasGlobalCreds] = useState(false);

  // Firmware versions state
  const [firmwareVersions, setFirmwareVersions] = useState<FirmwareVersion[]>([]);
  const [newFwPrefix, setNewFwPrefix] = useState('');
  const [newFwVersion, setNewFwVersion] = useState('');

  // Batch settings
  const [batchWaitTime, setBatchWaitTime] = useState(10);
  const [includeErrors, setIncludeErrors] = useState(false);

  // Tab state
  const [activeTab, setActiveTab] = useState<'dashboard' | 'routers' | 'history' | 'settings'>('dashboard');

  const addLiveEvent = useCallback((type: string, message: string, level: LiveEvent['level'] = 'info') => {
    const event: LiveEvent = {
      id: `${Date.now()}-${Math.random()}`,
      type,
      timestamp: new Date().toISOString(),
      message,
      level
    };
    setLiveEvents(prev => [...prev.slice(-99), event]);
  }, []);

  const connectToEventStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const eventSource = new EventSource('/api/events');
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        const { type, data } = event;

        switch (type) {
          case 'job_started':
            addLiveEvent(type, data.message, 'info');
            setProgress({ completed: 0, failed: 0, total: data.total || 0, percent: 0 });
            break;

          case 'job_progress':
            setProgress({
              completed: data.completed || 0,
              failed: data.failed || 0,
              total: data.total || 0,
              percent: data.progress || 0
            });
            break;

          case 'job_completed':
            addLiveEvent(type, data.message, data.status === 'completed' ? 'success' : 'warning');
            setProgress(null);
            setWaitingTime(null);
            fetchActiveJob();
            fetchRouters();
            fetchHistory();
            break;

          case 'batch_started':
            addLiveEvent(type, data.message, 'info');
            setWaitingTime(null);
            break;

          case 'batch_completed':
            addLiveEvent(type, `${data.message} - Erfolgreich: ${data.completed}, Fehlgeschlagen: ${data.failed}`,
              data.failed > 0 ? 'warning' : 'success');
            break;

          case 'batch_waiting':
            setWaitingTime(data.waitTimeRemaining);
            if (data.waitTimeRemaining === 10 || data.waitTimeRemaining === 5 || data.waitTimeRemaining === 1) {
              addLiveEvent(type, data.message, 'info');
            }
            break;

          case 'router_started':
            addLiveEvent(type, `[${data.deviceName}] Update gestartet (${data.ipAddress})`, 'info');
            break;

          case 'router_progress':
            addLiveEvent(type, `[${data.deviceName}] ${data.message}`, 'info');
            break;

          case 'router_completed':
            addLiveEvent(type, `[${data.deviceName}] Update erfolgreich: ${data.firmwareBefore} -> ${data.firmwareAfter}`, 'success');
            fetchRouters();
            break;

          case 'router_failed':
            addLiveEvent(type, `[${data.deviceName}] Fehler: ${data.error}`, 'error');
            fetchRouters();
            break;
        }
      } catch (err) {
        console.error('Error parsing event:', err);
      }
    };

    eventSource.onerror = () => {
      console.log('EventSource error, reconnecting...');
      setTimeout(connectToEventStream, 3000);
    };
  }, [addLiveEvent]);

  // Auto-scroll log to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [liveEvents]);

  const fetchRouters = useCallback(async () => {
    try {
      const res = await fetch('/api/routers');
      const data = await res.json();
      setRouters(data.routers || []);
      setStats(data.stats || []);
    } catch (error) {
      console.error('Failed to fetch routers:', error);
    }
  }, []);

  const fetchActiveJob = useCallback(async () => {
    try {
      const res = await fetch('/api/update');
      const data = await res.json();
      setActiveJob(data.activeJob || null);
    } catch (error) {
      console.error('Failed to fetch active job:', error);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/history?limit=50');
      const data = await res.json();
      setHistory(data.history || []);
    } catch (error) {
      console.error('Failed to fetch history:', error);
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      setHasGlobalCreds(data.hasGlobalCredentials);
      if (data.username) {
        setGlobalUsername(data.username);
      }
      if (data.batchWaitTime !== undefined) {
        setBatchWaitTime(data.batchWaitTime);
      }
    } catch (error) {
      console.error('Failed to fetch settings:', error);
    }
  }, []);

  const fetchFirmwareVersions = useCallback(async () => {
    try {
      const res = await fetch('/api/firmware-versions');
      const data = await res.json();
      setFirmwareVersions(data.versions || []);
    } catch (error) {
      console.error('Failed to fetch firmware versions:', error);
    }
  }, []);

  useEffect(() => {
    fetchRouters();
    fetchActiveJob();
    fetchHistory();
    fetchSettings();
    fetchFirmwareVersions();
    connectToEventStream();

    return () => {
      eventSourceRef.current?.close();
    };
  }, [fetchRouters, fetchActiveJob, fetchHistory, fetchSettings, fetchFirmwareVersions, connectToEventStream]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    setMessage(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('clearExisting', 'true');

    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();

      if (data.success) {
        setMessage({ type: 'success', text: `${data.imported} Router importiert` });
        fetchRouters();
      } else {
        setMessage({ type: 'error', text: data.error || 'Import fehlgeschlagen' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'Import fehlgeschlagen' });
    } finally {
      setIsLoading(false);
      e.target.value = '';
    }
  };

  const handleSaveCredentials = async () => {
    if (!globalUsername || !globalPassword) {
      setMessage({ type: 'error', text: 'Benutzername und Passwort erforderlich' });
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: globalUsername, password: globalPassword })
      });
      const data = await res.json();

      if (data.success) {
        setMessage({ type: 'success', text: 'Zugangsdaten gespeichert' });
        setHasGlobalCreds(true);
        fetchSettings();
      } else {
        setMessage({ type: 'error', text: data.error });
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'Speichern fehlgeschlagen' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCheckFirmware = async (routerIds?: string[]) => {
    setIsLoading(true);
    setMessage(null);

    try {
      const res = await fetch('/api/routers/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ routerIds })
      });
      const data = await res.json();

      if (data.success) {
        setMessage({ type: 'success', text: `${data.checked} Router geprüft` });
        fetchRouters();
      } else {
        setMessage({ type: 'error', text: data.error });
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'Prüfung fehlgeschlagen' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleStartUpdate = async () => {
    const routerIds = selectedRouters.size > 0 ? Array.from(selectedRouters) : undefined;

    setIsLoading(true);
    setMessage(null);
    setLiveEvents([]);

    try {
      const res = await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ routerIds, batchSize, includeErrors })
      });
      const data = await res.json();

      if (data.success) {
        setMessage({ type: 'success', text: `Update-Job gestartet: ${data.totalRouters} Router in Batches von ${data.batchSize}` });
        setSelectedRouters(new Set());
        setIncludeErrors(false); // Reset after starting
        fetchActiveJob();
      } else {
        setMessage({ type: 'error', text: data.error });
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'Update fehlgeschlagen' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelJob = async () => {
    if (!activeJob) return;

    try {
      const res = await fetch(`/api/update?jobId=${activeJob.id}`, { method: 'DELETE' });
      const data = await res.json();

      if (data.success) {
        setMessage({ type: 'success', text: 'Job abgebrochen' });
        fetchActiveJob();
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'Abbruch fehlgeschlagen' });
    }
  };

  const toggleRouterSelection = (id: string) => {
    const newSelection = new Set(selectedRouters);
    if (newSelection.has(id)) {
      newSelection.delete(id);
    } else {
      newSelection.add(id);
    }
    setSelectedRouters(newSelection);
  };

  const selectAllUpdateable = () => {
    const updateable = routers.filter(r => r.status === 'update_available').map(r => r.id);
    setSelectedRouters(new Set(updateable));
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      'unknown': 'bg-gray-500',
      'up_to_date': 'bg-green-500',
      'update_available': 'bg-yellow-500',
      'updating': 'bg-blue-500 animate-pulse',
      'unreachable': 'bg-red-500',
      'error': 'bg-red-700'
    };
    const labels: Record<string, string> = {
      'unknown': 'Unbekannt',
      'up_to_date': 'Aktuell',
      'update_available': 'Update verfügbar',
      'updating': 'Update läuft...',
      'unreachable': 'Nicht erreichbar',
      'error': 'Fehler'
    };
    return (
      <span className={`px-2 py-1 rounded text-white text-xs ${styles[status] || 'bg-gray-500'}`}>
        {labels[status] || status}
      </span>
    );
  };

  const getEventColor = (level: LiveEvent['level']) => {
    switch (level) {
      case 'success': return 'text-green-400';
      case 'error': return 'text-red-400';
      case 'warning': return 'text-yellow-400';
      default: return 'text-gray-300';
    }
  };

  return (
    <main className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="bg-gray-800 border-b border-gray-700 p-4">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <h1 className="text-2xl font-bold">Teltonika Firmware Updater</h1>
          <div className="flex gap-4">
            <span className="text-gray-400">Router: {routers.length}</span>
            {hasGlobalCreds && <span className="text-green-400">Credentials: OK</span>}
          </div>
        </div>
      </header>

      {/* Message */}
      {message && (
        <div className={`p-4 ${message.type === 'success' ? 'bg-green-800' : 'bg-red-800'}`}>
          <div className="max-w-7xl mx-auto">{message.text}</div>
        </div>
      )}

      {/* Active Job Banner with Progress */}
      {activeJob && activeJob.status === 'running' && (
        <div className="bg-blue-800 p-4">
          <div className="max-w-7xl mx-auto">
            <div className="flex justify-between items-center mb-2">
              <div>
                <span className="font-bold">Update läuft:</span>{' '}
                {progress ? `${progress.completed + progress.failed} / ${progress.total}` : `${activeJob.completed_routers + activeJob.failed_routers} / ${activeJob.total_routers}`} Router
                {(progress?.failed || activeJob.failed_routers) > 0 && (
                  <span className="text-red-300 ml-2">({progress?.failed || activeJob.failed_routers} fehlgeschlagen)</span>
                )}
                {waitingTime && (
                  <span className="text-yellow-300 ml-4">Warte noch {waitingTime} Min. bis zum nächsten Batch...</span>
                )}
              </div>
              <button
                onClick={handleCancelJob}
                className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded"
              >
                Abbrechen
              </button>
            </div>
            {progress && (
              <div className="w-full bg-gray-700 rounded-full h-2">
                <div
                  className="bg-green-500 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="bg-gray-800 border-b border-gray-700">
        <div className="max-w-7xl mx-auto flex">
          {['dashboard', 'routers', 'history', 'settings'].map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab as typeof activeTab)}
              className={`px-6 py-3 font-medium ${
                activeTab === tab
                  ? 'text-white border-b-2 border-blue-500'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {tab === 'dashboard' && 'Dashboard'}
              {tab === 'routers' && 'Router'}
              {tab === 'history' && 'Historie'}
              {tab === 'settings' && 'Einstellungen'}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-6">
        {/* Dashboard Tab */}
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-gray-800 p-4 rounded-lg">
                <div className="text-3xl font-bold">{routers.length}</div>
                <div className="text-gray-400">Gesamt</div>
              </div>
              <div className="bg-gray-800 p-4 rounded-lg">
                <div className="text-3xl font-bold text-green-400">
                  {stats.find(s => s.status === 'up_to_date')?.count || 0}
                </div>
                <div className="text-gray-400">Aktuell</div>
              </div>
              <div className="bg-gray-800 p-4 rounded-lg">
                <div className="text-3xl font-bold text-yellow-400">
                  {stats.find(s => s.status === 'update_available')?.count || 0}
                </div>
                <div className="text-gray-400">Update verfügbar</div>
              </div>
              <div className="bg-gray-800 p-4 rounded-lg">
                <div className="text-3xl font-bold text-red-400">
                  {(stats.find(s => s.status === 'unreachable')?.count || 0) +
                   (stats.find(s => s.status === 'error')?.count || 0)}
                </div>
                <div className="text-gray-400">Fehler</div>
              </div>
            </div>

            {/* Actions */}
            <div className="bg-gray-800 p-6 rounded-lg space-y-4">
              <h2 className="text-xl font-bold">Aktionen</h2>

              <div className="flex flex-wrap gap-4">
                <label className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded cursor-pointer">
                  Excel importieren
                  <input
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={handleFileUpload}
                    className="hidden"
                    disabled={isLoading}
                  />
                </label>

                <button
                  onClick={() => handleCheckFirmware()}
                  disabled={isLoading || routers.length === 0}
                  className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded disabled:opacity-50"
                >
                  Alle prüfen
                </button>

                <div className="flex items-center gap-2">
                  <select
                    value={batchSize}
                    onChange={e => setBatchSize(Number(e.target.value))}
                    className="bg-gray-700 px-3 py-2 rounded"
                  >
                    <option value={5}>5 pro Batch</option>
                    <option value={10}>10 pro Batch</option>
                    <option value={25}>25 pro Batch</option>
                    <option value={100}>100 pro Batch</option>
                  </select>

                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={includeErrors}
                      onChange={e => setIncludeErrors(e.target.checked)}
                      className="rounded"
                    />
                    <span className="text-gray-300">
                      + Fehlgeschlagene ({stats.find(s => s.status === 'error')?.count || 0})
                    </span>
                  </label>

                  <button
                    onClick={handleStartUpdate}
                    disabled={isLoading || activeJob !== null ||
                      ((stats.find(s => s.status === 'update_available')?.count || 0) === 0 &&
                       (!includeErrors || (stats.find(s => s.status === 'error')?.count || 0) === 0))}
                    className="bg-orange-600 hover:bg-orange-700 px-4 py-2 rounded disabled:opacity-50"
                  >
                    Updates starten
                  </button>
                </div>
              </div>
            </div>

            {/* Live Log */}
            <div className="bg-gray-800 p-6 rounded-lg">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-bold">Live-Log</h2>
                <button
                  onClick={() => setLiveEvents([])}
                  className="text-sm text-gray-400 hover:text-white"
                >
                  Log leeren
                </button>
              </div>
              <div className="bg-black rounded-lg p-4 h-64 overflow-y-auto font-mono text-sm">
                {liveEvents.length === 0 ? (
                  <p className="text-gray-500">Warte auf Events...</p>
                ) : (
                  liveEvents.map(event => (
                    <div key={event.id} className={`${getEventColor(event.level)} mb-1`}>
                      <span className="text-gray-500">
                        [{new Date(event.timestamp).toLocaleTimeString('de-DE')}]
                      </span>{' '}
                      {event.message}
                    </div>
                  ))
                )}
                <div ref={logEndRef} />
              </div>
            </div>

            {/* Recent History */}
            <div className="bg-gray-800 p-6 rounded-lg">
              <h2 className="text-xl font-bold mb-4">Letzte Updates</h2>
              {history.length === 0 ? (
                <p className="text-gray-400">Keine Updates durchgeführt</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-400">
                        <th className="p-2">Gerät</th>
                        <th className="p-2">Vorher</th>
                        <th className="p-2">Nachher</th>
                        <th className="p-2">Status</th>
                        <th className="p-2">Zeitpunkt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.slice(0, 10).map(h => (
                        <tr key={h.id} className="border-t border-gray-700">
                          <td className="p-2">{h.device_name}</td>
                          <td className="p-2 text-gray-400">{h.firmware_before || '-'}</td>
                          <td className="p-2 text-green-400">{h.firmware_after || '-'}</td>
                          <td className="p-2">
                            {h.status === 'success' ? (
                              <span className="text-green-400">Erfolgreich</span>
                            ) : h.status === 'failed' ? (
                              <span className="text-red-400" title={h.error_message || ''}>
                                Fehlgeschlagen
                              </span>
                            ) : (
                              <span className="text-blue-400">Läuft...</span>
                            )}
                          </td>
                          <td className="p-2 text-gray-400">
                            {h.completed_at ? new Date(h.completed_at).toLocaleString('de-DE') : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Routers Tab */}
        {activeTab === 'routers' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold">Router ({routers.length})</h2>
              <div className="flex gap-2">
                <button
                  onClick={selectAllUpdateable}
                  className="bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-sm"
                >
                  Updatebare auswählen
                </button>
                <button
                  onClick={() => setSelectedRouters(new Set())}
                  className="bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-sm"
                >
                  Auswahl löschen
                </button>
                {selectedRouters.size > 0 && (
                  <>
                    <button
                      onClick={() => handleCheckFirmware(Array.from(selectedRouters))}
                      disabled={isLoading}
                      className="bg-green-600 hover:bg-green-700 px-3 py-1 rounded text-sm disabled:opacity-50"
                    >
                      Ausgewählte prüfen ({selectedRouters.size})
                    </button>
                    <button
                      onClick={handleStartUpdate}
                      disabled={isLoading || activeJob !== null}
                      className="bg-orange-600 hover:bg-orange-700 px-3 py-1 rounded text-sm disabled:opacity-50"
                    >
                      Ausgewählte updaten ({selectedRouters.size})
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="bg-gray-800 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 bg-gray-900">
                    <th className="p-3 w-10">
                      <input
                        type="checkbox"
                        checked={selectedRouters.size === routers.length && routers.length > 0}
                        onChange={() => {
                          if (selectedRouters.size === routers.length) {
                            setSelectedRouters(new Set());
                          } else {
                            setSelectedRouters(new Set(routers.map(r => r.id)));
                          }
                        }}
                      />
                    </th>
                    <th className="p-3">Gerätename</th>
                    <th className="p-3">IP-Adresse</th>
                    <th className="p-3">Aktuelle FW</th>
                    <th className="p-3">Verfügbare FW</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Zuletzt geprüft</th>
                  </tr>
                </thead>
                <tbody>
                  {routers.map(router => (
                    <tr
                      key={router.id}
                      className={`border-t border-gray-700 hover:bg-gray-700 ${
                        selectedRouters.has(router.id) ? 'bg-gray-700' : ''
                      }`}
                    >
                      <td className="p-3">
                        <input
                          type="checkbox"
                          checked={selectedRouters.has(router.id)}
                          onChange={() => toggleRouterSelection(router.id)}
                        />
                      </td>
                      <td className="p-3 font-medium">{router.device_name}</td>
                      <td className="p-3 text-gray-400">{router.ip_address}</td>
                      <td className="p-3">{router.current_firmware || '-'}</td>
                      <td className="p-3 text-yellow-400">{router.available_firmware || '-'}</td>
                      <td className="p-3">{getStatusBadge(router.status)}</td>
                      <td className="p-3 text-gray-400">
                        {router.last_check
                          ? new Date(router.last_check).toLocaleString('de-DE')
                          : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* History Tab */}
        {activeTab === 'history' && (
          <div className="space-y-4">
            <h2 className="text-xl font-bold">Update-Historie</h2>

            <div className="bg-gray-800 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 bg-gray-900">
                    <th className="p-3">Gerät</th>
                    <th className="p-3">IP</th>
                    <th className="p-3">Firmware vorher</th>
                    <th className="p-3">Firmware nachher</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Fehler</th>
                    <th className="p-3">Gestartet</th>
                    <th className="p-3">Beendet</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(h => (
                    <tr key={h.id} className="border-t border-gray-700">
                      <td className="p-3 font-medium">{h.device_name}</td>
                      <td className="p-3 text-gray-400">{h.ip_address}</td>
                      <td className="p-3">{h.firmware_before || '-'}</td>
                      <td className="p-3 text-green-400">{h.firmware_after || '-'}</td>
                      <td className="p-3">
                        {h.status === 'success' ? (
                          <span className="text-green-400">Erfolgreich</span>
                        ) : h.status === 'failed' ? (
                          <span className="text-red-400">Fehlgeschlagen</span>
                        ) : (
                          <span className="text-blue-400">Läuft...</span>
                        )}
                      </td>
                      <td className="p-3 text-red-400 max-w-xs truncate" title={h.error_message || ''}>
                        {h.error_message || '-'}
                      </td>
                      <td className="p-3 text-gray-400">
                        {h.started_at ? new Date(h.started_at).toLocaleString('de-DE') : '-'}
                      </td>
                      <td className="p-3 text-gray-400">
                        {h.completed_at ? new Date(h.completed_at).toLocaleString('de-DE') : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Settings Tab */}
        {activeTab === 'settings' && (
          <div className="space-y-6">
            <h2 className="text-xl font-bold">Einstellungen</h2>

            <div className="bg-gray-800 p-6 rounded-lg max-w-lg">
              <h3 className="text-lg font-semibold mb-4">Globale Zugangsdaten</h3>
              <p className="text-gray-400 mb-4">
                Diese Zugangsdaten werden verwendet, wenn Router keine individuellen Credentials haben.
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Benutzername</label>
                  <input
                    type="text"
                    value={globalUsername}
                    onChange={e => setGlobalUsername(e.target.value)}
                    className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"
                    placeholder="root"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Passwort</label>
                  <input
                    type="password"
                    value={globalPassword}
                    onChange={e => setGlobalPassword(e.target.value)}
                    className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"
                    placeholder="Passwort"
                  />
                </div>
                <button
                  onClick={handleSaveCredentials}
                  disabled={isLoading}
                  className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded disabled:opacity-50"
                >
                  Speichern
                </button>
                {hasGlobalCreds && (
                  <p className="text-green-400 text-sm">Zugangsdaten sind konfiguriert</p>
                )}
              </div>
            </div>

            <div className="bg-gray-800 p-6 rounded-lg max-w-lg">
              <h3 className="text-lg font-semibold mb-4">Batch-Einstellungen</h3>
              <p className="text-gray-400 mb-4">
                Nach jedem Batch wird gewartet, bevor der nächste Batch startet.
              </p>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Standard Batch-Größe</label>
                  <select
                    value={batchSize}
                    onChange={e => setBatchSize(Number(e.target.value))}
                    className="bg-gray-700 border border-gray-600 rounded px-3 py-2"
                  >
                    <option value={5}>5 Router pro Batch</option>
                    <option value={10}>10 Router pro Batch</option>
                    <option value={25}>25 Router pro Batch</option>
                    <option value={100}>100 Router pro Batch</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Wartezeit zwischen Batches (Minuten)</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min="0"
                      max="60"
                      value={batchWaitTime}
                      onChange={e => setBatchWaitTime(Number(e.target.value))}
                      className="bg-gray-700 border border-gray-600 rounded px-3 py-2 w-24"
                    />
                    <button
                      onClick={async () => {
                        try {
                          const res = await fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ batchWaitTime })
                          });
                          const data = await res.json();
                          if (data.success) {
                            setMessage({ type: 'success', text: `Wartezeit auf ${batchWaitTime} Minuten gesetzt` });
                          } else {
                            setMessage({ type: 'error', text: data.error });
                          }
                        } catch {
                          setMessage({ type: 'error', text: 'Speichern fehlgeschlagen' });
                        }
                      }}
                      className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded"
                    >
                      Speichern
                    </button>
                  </div>
                  <p className="text-gray-500 text-sm mt-1">0 = keine Wartezeit</p>
                </div>
              </div>
            </div>

            {/* Firmware Versions */}
            <div className="bg-gray-800 p-6 rounded-lg">
              <h3 className="text-lg font-semibold mb-4">Firmware-Versionen</h3>
              <p className="text-gray-400 mb-4">
                Hier die neuesten Firmware-Versionen pro Gerätetyp pflegen. Diese werden verwendet,
                wenn der Router keine Update-Informationen vom FOTA-Server abrufen kann.
              </p>

              {/* Add new version */}
              <div className="flex gap-2 mb-4">
                <input
                  type="text"
                  value={newFwPrefix}
                  onChange={e => setNewFwPrefix(e.target.value.toUpperCase())}
                  className="bg-gray-700 border border-gray-600 rounded px-3 py-2 w-32"
                  placeholder="z.B. RUT9"
                />
                <input
                  type="text"
                  value={newFwVersion}
                  onChange={e => setNewFwVersion(e.target.value)}
                  className="bg-gray-700 border border-gray-600 rounded px-3 py-2 flex-1"
                  placeholder="z.B. RUT9_R_00.07.06.20"
                />
                <button
                  onClick={async () => {
                    if (!newFwPrefix || !newFwVersion) {
                      setMessage({ type: 'error', text: 'Prefix und Version erforderlich' });
                      return;
                    }
                    try {
                      const res = await fetch('/api/firmware-versions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ device_prefix: newFwPrefix, latest_version: newFwVersion })
                      });
                      const data = await res.json();
                      if (data.success) {
                        setMessage({ type: 'success', text: `Firmware-Version für ${newFwPrefix} gespeichert` });
                        setNewFwPrefix('');
                        setNewFwVersion('');
                        fetchFirmwareVersions();
                      } else {
                        setMessage({ type: 'error', text: data.error });
                      }
                    } catch {
                      setMessage({ type: 'error', text: 'Speichern fehlgeschlagen' });
                    }
                  }}
                  className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded"
                >
                  Hinzufügen
                </button>
              </div>

              {/* Versions table */}
              {firmwareVersions.length > 0 ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-400 border-b border-gray-700">
                      <th className="pb-2">Gerätetyp</th>
                      <th className="pb-2">Neueste Version</th>
                      <th className="pb-2">Aktualisiert</th>
                      <th className="pb-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {firmwareVersions.map(fw => (
                      <tr key={fw.device_prefix} className="border-b border-gray-700">
                        <td className="py-2 font-medium">{fw.device_prefix}</td>
                        <td className="py-2 text-green-400">{fw.latest_version}</td>
                        <td className="py-2 text-gray-400">
                          {new Date(fw.updated_at).toLocaleString('de-DE')}
                        </td>
                        <td className="py-2 text-right">
                          <button
                            onClick={async () => {
                              if (confirm(`${fw.device_prefix} löschen?`)) {
                                await fetch(`/api/firmware-versions?prefix=${fw.device_prefix}`, { method: 'DELETE' });
                                fetchFirmwareVersions();
                              }
                            }}
                            className="text-red-400 hover:text-red-300"
                          >
                            Löschen
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-gray-500">Keine Firmware-Versionen konfiguriert</p>
              )}

              <div className="mt-4 p-3 bg-gray-700 rounded text-sm text-gray-300">
                <strong>Tipp:</strong> Gängige Präfixe sind RUT9 (RUT955, RUT950), RUT2 (RUT240, RUT241),
                RUTX (RUTX09, RUTX11), TRB1 (TRB140, TRB142)
              </div>
            </div>

            <div className="bg-gray-800 p-6 rounded-lg max-w-lg">
              <h3 className="text-lg font-semibold mb-4 text-red-400">Gefahrenzone</h3>
              <button
                onClick={async () => {
                  if (confirm('Alle Router löschen?')) {
                    await fetch('/api/routers', { method: 'DELETE' });
                    fetchRouters();
                    setMessage({ type: 'success', text: 'Alle Router gelöscht' });
                  }
                }}
                className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded"
              >
                Alle Router löschen
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
