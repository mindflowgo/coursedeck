import SwiftUI

@main
struct CourseDeckApp: App {
    @StateObject private var services = AppServices.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            SceneLifecycleRoot {
                LibraryView()
            }
            .environmentObject(services)
            .task {
                services.start()
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    Task { await services.runDocumentsAudit() }
                }
            }
        }
    }
}
