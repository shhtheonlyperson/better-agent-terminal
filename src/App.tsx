import { useEffect, useState, useCallback } from 'react'
import { workspaceStore } from './stores/workspace-store'
import { settingsStore } from './stores/settings-store'
import { Sidebar } from './components/Sidebar'
import { WorkspaceView } from './components/WorkspaceView'
import { SettingsPanel } from './components/SettingsPanel'
import { AboutPanel } from './components/AboutPanel'
import { SnippetSidebar } from './components/SnippetPanel'
import { WorkspaceEnvDialog } from './components/WorkspaceEnvDialog'
import { ResizeHandle } from './components/ResizeHandle'
import { ProfilePanel } from './components/ProfilePanel'
import type { AppState, EnvVariable } from './types'

// Panel settings interface
interface PanelSettings {
  sidebar: {
    width: number
  }
  snippetSidebar: {
    width: number
    collapsed: boolean
  }
}

const PANEL_SETTINGS_KEY = 'better-terminal-panel-settings'
const DEFAULT_SIDEBAR_WIDTH = 220
const MIN_SIDEBAR_WIDTH = 160
const MAX_SIDEBAR_WIDTH = 400
const DEFAULT_SNIPPET_WIDTH = 280
const MIN_SNIPPET_WIDTH = 180
const MAX_SNIPPET_WIDTH = 500

function loadPanelSettings(): PanelSettings {
  try {
    const saved = localStorage.getItem(PANEL_SETTINGS_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      // Ensure sidebar settings exist (migration from old format)
      return {
        sidebar: parsed.sidebar || { width: DEFAULT_SIDEBAR_WIDTH },
        snippetSidebar: parsed.snippetSidebar || { width: DEFAULT_SNIPPET_WIDTH, collapsed: true }
      }
    }
  } catch (e) {
    console.error('Failed to load panel settings:', e)
  }
  return {
    sidebar: { width: DEFAULT_SIDEBAR_WIDTH },
    snippetSidebar: { width: DEFAULT_SNIPPET_WIDTH, collapsed: true }
  }
}

function savePanelSettings(settings: PanelSettings): void {
  try {
    localStorage.setItem(PANEL_SETTINGS_KEY, JSON.stringify(settings))
  } catch (e) {
    console.error('Failed to save panel settings:', e)
  }
}

export default function App() {
  const [state, setState] = useState<AppState>(workspaceStore.getState())
  const [showSettings, setShowSettings] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [showProfiles, setShowProfiles] = useState(false)
  const [activeProfileName, setActiveProfileName] = useState<string>('Default')
  const [isRemoteConnected, setIsRemoteConnected] = useState(false)
  const [envDialogWorkspaceId, setEnvDialogWorkspaceId] = useState<string | null>(null)
  // Snippet sidebar is always visible by default
  const [showSnippetSidebar] = useState(true)
  // Panel settings for resizable panels
  const [panelSettings, setPanelSettings] = useState<PanelSettings>(loadPanelSettings)
  // Detached workspace support
  const [detachedWorkspaceId] = useState(() => window.electronAPI.workspace.getDetachedId())
  const [detachedIds, setDetachedIds] = useState<Set<string>>(new Set())

  // Handle sidebar resize
  const handleSidebarResize = useCallback((delta: number) => {
    setPanelSettings(prev => {
      // Note: delta is positive when dragging right (making sidebar wider)
      const newWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, prev.sidebar.width + delta))
      const updated = { ...prev, sidebar: { ...prev.sidebar, width: newWidth } }
      savePanelSettings(updated)
      return updated
    })
  }, [])

  // Reset sidebar to default width
  const handleSidebarResetWidth = useCallback(() => {
    setPanelSettings(prev => {
      const updated = { ...prev, sidebar: { ...prev.sidebar, width: DEFAULT_SIDEBAR_WIDTH } }
      savePanelSettings(updated)
      return updated
    })
  }, [])

  // Handle snippet sidebar resize
  const handleSnippetResize = useCallback((delta: number) => {
    setPanelSettings(prev => {
      // Note: delta is negative when dragging left (making sidebar wider)
      const newWidth = Math.min(MAX_SNIPPET_WIDTH, Math.max(MIN_SNIPPET_WIDTH, prev.snippetSidebar.width - delta))
      const updated = { ...prev, snippetSidebar: { ...prev.snippetSidebar, width: newWidth } }
      savePanelSettings(updated)
      return updated
    })
  }, [])

  // Toggle snippet sidebar collapse
  const handleSnippetCollapse = useCallback(() => {
    setPanelSettings(prev => {
      const updated = { ...prev, snippetSidebar: { ...prev.snippetSidebar, collapsed: !prev.snippetSidebar.collapsed } }
      savePanelSettings(updated)
      return updated
    })
  }, [])

  // Reset snippet sidebar to default width
  const handleSnippetResetWidth = useCallback(() => {
    setPanelSettings(prev => {
      const updated = { ...prev, snippetSidebar: { ...prev.snippetSidebar, width: DEFAULT_SNIPPET_WIDTH } }
      savePanelSettings(updated)
      return updated
    })
  }, [])

  useEffect(() => {
    const unsubscribe = workspaceStore.subscribe(() => {
      setState(workspaceStore.getState())
    })

    // Global listener for all terminal output - updates activity for ALL terminals
    // This is needed because WorkspaceView only renders terminals for the active workspace
    const unsubscribeOutput = window.electronAPI.pty.onOutput((id) => {
      workspaceStore.updateTerminalActivity(id)
    })

    // Load saved workspaces and settings on startup
    // If active profile is remote, try to connect; fall back to local on failure
    const initProfile = async () => {
      const result = await window.electronAPI.profile.list()
      const active = result.profiles.find(p => p.id === result.activeProfileId)
      if (active?.type === 'remote' && active.remoteHost && active.remoteToken) {
        // Try connecting to remote
        const connectResult = await window.electronAPI.remote.connect(
          active.remoteHost,
          active.remotePort || 9876,
          active.remoteToken
        )
        if ('error' in connectResult) {
          // Connection failed — fall back to first local profile
          const localProfile = result.profiles.find(p => p.type !== 'remote')
          if (localProfile) {
            await window.electronAPI.profile.load(localProfile.id)
            setActiveProfileName(localProfile.name)
          } else {
            // No local profile available (new-window launch) — close window
            window.close()
            return
          }
        } else {
          setActiveProfileName(active.name)
          setIsRemoteConnected(true)
        }
      } else if (active?.type === 'remote') {
        // Remote profile missing connection info — fall back
        const localProfile = result.profiles.find(p => p.type !== 'remote')
        if (localProfile) {
          await window.electronAPI.profile.load(localProfile.id)
          setActiveProfileName(localProfile.name)
        }
      } else if (active) {
        setActiveProfileName(active.name)
      }
      await workspaceStore.load()
      settingsStore.load()
    }
    initProfile()

    // Listen for workspace detach/reattach events (main window only)
    const unsubDetach = window.electronAPI.workspace.onDetached((wsId) => {
      setDetachedIds(prev => new Set(prev).add(wsId))
    })
    const unsubReattach = window.electronAPI.workspace.onReattached((wsId) => {
      setDetachedIds(prev => {
        const next = new Set(prev)
        next.delete(wsId)
        return next
      })
    })

    return () => {
      unsubscribe()
      unsubscribeOutput()
      unsubDetach()
      unsubReattach()
    }
  }, [])

  // Poll remote client connection status
  useEffect(() => {
    const check = () => {
      window.electronAPI.remote.clientStatus().then(s => setIsRemoteConnected(s.connected))
    }
    check()
    const interval = setInterval(check, 3000)
    return () => clearInterval(interval)
  }, [])

  const handleAddWorkspace = useCallback(async () => {
    const folderPath = await window.electronAPI.dialog.selectFolder()
    if (folderPath) {
      const name = folderPath.split(/[/\\]/).pop() || 'Workspace'
      workspaceStore.addWorkspace(name, folderPath)
      workspaceStore.save()
    }
  }, [])

  const handleDetachWorkspace = useCallback(async (workspaceId: string) => {
    await window.electronAPI.workspace.detach(workspaceId)
  }, [])

  // Paste content to focused terminal
  const handlePasteToTerminal = useCallback((content: string) => {
    const currentState = workspaceStore.getState()
    // Try focused terminal first, then fall back to active terminal or first terminal in active workspace
    let terminalId = currentState.focusedTerminalId

    if (!terminalId && currentState.activeWorkspaceId) {
      const workspaceTerminals = workspaceStore.getWorkspaceTerminals(currentState.activeWorkspaceId)
      if (workspaceTerminals.length > 0) {
        terminalId = workspaceTerminals[0].id
      }
    }

    if (terminalId) {
      window.electronAPI.pty.write(terminalId, content)
    } else {
      console.warn('No terminal available to paste to')
    }
  }, [])

  // Handle profile switch: kill all terminals, load profile, reload store
  const handleProfileSwitch = useCallback(async (profileId: string) => {
    // Kill all running terminals and claude sessions
    const currentState = workspaceStore.getState()
    for (const terminal of currentState.terminals) {
      try { await window.electronAPI.pty.kill(terminal.id) } catch { /* ignore */ }
    }

    // Disconnect existing remote connection if any
    await window.electronAPI.remote.disconnect()

    // Check if this is a remote profile
    const profile = await window.electronAPI.profile.get(profileId)
    if (!profile) return

    if (profile.type === 'remote' && profile.remoteHost && profile.remoteToken) {
      // Connect to remote host
      const connectResult = await window.electronAPI.remote.connect(
        profile.remoteHost,
        profile.remotePort || 9876,
        profile.remoteToken
      )
      if ('error' in connectResult) {
        alert(`Remote connection failed: ${connectResult.error}\nSwitching back to local profile.`)
        // Fall back to first local profile
        const listResult = await window.electronAPI.profile.list()
        const localProfile = listResult.profiles.find(p => p.type !== 'remote')
        if (localProfile) {
          await window.electronAPI.profile.load(localProfile.id)
          await workspaceStore.load()
          setActiveProfileName(localProfile.name)
        }
        setIsRemoteConnected(false)
        setShowProfiles(false)
        return
      }
      // Set as active profile (no local workspace load for remote)
      await window.electronAPI.profile.setActiveId(profileId)
    } else {
      // Load the local profile (writes to workspaces.json)
      const result = await window.electronAPI.profile.load(profileId)
      if (!result) return
    }

    // Reload workspace store from the (possibly remote) workspaces.json
    await workspaceStore.load()

    // Update active profile name and remote status
    const listResult = await window.electronAPI.profile.list()
    const active = listResult.profiles.find(p => p.id === listResult.activeProfileId)
    if (active) setActiveProfileName(active.name)
    setIsRemoteConnected(profile.type === 'remote')

    setShowProfiles(false)
  }, [])

  // Open profile in a new app instance
  const handleProfileNewWindow = useCallback(async (profileId: string) => {
    await window.electronAPI.app.openNewInstance(profileId)
    setShowProfiles(false)
  }, [])

  // Get the workspace for env dialog
  const envDialogWorkspace = envDialogWorkspaceId
    ? state.workspaces.find(w => w.id === envDialogWorkspaceId)
    : null

  // Detached window mode — render only that workspace, no sidebar
  if (detachedWorkspaceId) {
    const ws = state.workspaces.find(w => w.id === detachedWorkspaceId)
    if (!ws) {
      return (
        <div className="app">
          <main className="main-content">
            <div className="empty-state">
              <h2>Workspace not found</h2>
              <p>This detached workspace may have been removed.</p>
            </div>
          </main>
        </div>
      )
    }
    return (
      <div className="app">
        <main className="main-content" style={{ width: '100%' }}>
          <div className="workspace-container active">
            <WorkspaceView
              workspace={ws}
              terminals={workspaceStore.getWorkspaceTerminals(ws.id)}
              focusedTerminalId={state.focusedTerminalId}
              isActive={true}
            />
          </div>
        </main>
      </div>
    )
  }

  // Filter out detached workspaces from main window
  const visibleWorkspaces = state.workspaces.filter(w => !detachedIds.has(w.id))

  return (
    <div className="app">
      <Sidebar
        width={panelSettings.sidebar.width}
        workspaces={visibleWorkspaces}
        activeWorkspaceId={state.activeWorkspaceId}
        groups={workspaceStore.getGroups()}
        activeGroup={workspaceStore.getActiveGroup()}
        onSetActiveGroup={(group) => workspaceStore.setActiveGroup(group)}
        onSetWorkspaceGroup={(id, group) => workspaceStore.setWorkspaceGroup(id, group)}
        onSelectWorkspace={(id) => workspaceStore.setActiveWorkspace(id)}
        onAddWorkspace={handleAddWorkspace}
        onRemoveWorkspace={(id) => {
          workspaceStore.removeWorkspace(id)
          workspaceStore.save()
        }}
        onRenameWorkspace={(id, alias) => {
          workspaceStore.renameWorkspace(id, alias)
          workspaceStore.save()
        }}
        onReorderWorkspaces={(workspaceIds) => {
          workspaceStore.reorderWorkspaces(workspaceIds)
        }}
        onOpenEnvVars={(workspaceId) => setEnvDialogWorkspaceId(workspaceId)}
        onDetachWorkspace={handleDetachWorkspace}
        activeProfileName={activeProfileName}
        isRemoteConnected={isRemoteConnected}
        onOpenProfiles={() => setShowProfiles(true)}
        onOpenSettings={() => setShowSettings(true)}
        onOpenAbout={() => setShowAbout(true)}
      />
      <ResizeHandle
        direction="horizontal"
        onResize={handleSidebarResize}
        onDoubleClick={handleSidebarResetWidth}
      />
      <main className="main-content">
        {visibleWorkspaces.length > 0 ? (
          // Render visible workspaces (excluding detached ones), hide inactive with CSS
          visibleWorkspaces.map(workspace => (
            <div
              key={workspace.id}
              className={`workspace-container ${workspace.id === state.activeWorkspaceId ? 'active' : 'hidden'}`}
            >
              <WorkspaceView
                workspace={workspace}
                terminals={workspaceStore.getWorkspaceTerminals(workspace.id)}
                focusedTerminalId={workspace.id === state.activeWorkspaceId ? state.focusedTerminalId : null}
                isActive={workspace.id === state.activeWorkspaceId}
              />
            </div>
          ))
        ) : (
          <div className="empty-state">
            <h2>Welcome to Better Agent Terminal</h2>
            <p>Click "+ Add Workspace" to get started</p>
          </div>
        )}
      </main>
      {/* Resize handle for snippet sidebar */}
      {showSnippetSidebar && !panelSettings.snippetSidebar.collapsed && (
        <ResizeHandle
          direction="horizontal"
          onResize={handleSnippetResize}
          onDoubleClick={handleSnippetResetWidth}
        />
      )}
      <SnippetSidebar
        isVisible={showSnippetSidebar}
        width={panelSettings.snippetSidebar.width}
        collapsed={panelSettings.snippetSidebar.collapsed}
        onCollapse={handleSnippetCollapse}
        onPasteToTerminal={handlePasteToTerminal}
      />
      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} />
      )}
      {showAbout && (
        <AboutPanel onClose={() => setShowAbout(false)} />
      )}
      {showProfiles && (
        <ProfilePanel onClose={() => setShowProfiles(false)} onSwitch={handleProfileSwitch} onSwitchNewWindow={handleProfileNewWindow} />
      )}
      {envDialogWorkspace && (
        <WorkspaceEnvDialog
          workspace={envDialogWorkspace}
          onAdd={(envVar: EnvVariable) => workspaceStore.addWorkspaceEnvVar(envDialogWorkspaceId!, envVar)}
          onRemove={(key: string) => workspaceStore.removeWorkspaceEnvVar(envDialogWorkspaceId!, key)}
          onUpdate={(key: string, updates: Partial<EnvVariable>) => workspaceStore.updateWorkspaceEnvVar(envDialogWorkspaceId!, key, updates)}
          onClose={() => setEnvDialogWorkspaceId(null)}
        />
      )}
    </div>
  )
}
