import SwiftUI

/// One instance exists per window scene. It converts each scene's lifecycle
/// into app-level active-scene counts so a multi-window session does not stop
/// the generation queue when only one window loses focus.
struct SceneLifecycleRoot<Content: View>: View {
    @EnvironmentObject private var services: AppServices
    @Environment(\.scenePhase) private var scenePhase
    @State private var sceneID = UUID()
    @State private var isRegisteredActive = false
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .onAppear { update(scenePhase) }
            .onChange(of: scenePhase) { _, phase in update(phase) }
            .onDisappear {
                if isRegisteredActive {
                    isRegisteredActive = false
                }
                // Window destruction interrupts immediately.
                services.scenePhaseChanged(sceneID, phase: .background)
            }
    }

    private func update(_ phase: ScenePhase) {
        switch phase {
        case .active:
            if !isRegisteredActive {
                isRegisteredActive = true
                services.scenePhaseChanged(sceneID, phase: .active)
            }
        case .inactive:
            if isRegisteredActive {
                isRegisteredActive = false
            }
            // A short grace in the coordinator keeps a running stream alive
            // if the scene becomes active again quickly.
            services.scenePhaseChanged(sceneID, phase: .inactive)
        case .background:
            if isRegisteredActive {
                isRegisteredActive = false
            }
            services.scenePhaseChanged(sceneID, phase: .background)
        @unknown default:
            break
        }
    }
}
