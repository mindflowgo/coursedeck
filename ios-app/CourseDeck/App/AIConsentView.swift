import SwiftUI

/// First-run AI data disclosure. Generation and the durable queue stay
/// stopped until the user accepts the current disclosure version.
struct AIConsentView: View {
    let onAccept: () -> Void
    let onNotNow: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Label("AI content generation", systemImage: "sparkles")
                        .font(.title2.bold())

                    Text("CourseDeck can send lesson material to an AI provider to generate summaries, cheatsheets, practice tests and course documents. This is optional.")
                        .font(.body)

                    disclosureSection(
                        title: "Providers",
                        text: "Requests go directly from this iPad to the endpoint configured in Settings. The default card uses DeepSeek (api.deepseek.com, model deepseek-flash). A GLM card for opencode.ai (glm-5.3-flash) is also supported. You can add other OpenAI-compatible endpoints."
                    )

                    disclosureSection(
                        title: "What is sent",
                        text: "The selected prompt, lesson bodies, summaries, cheatsheets, existing question coverage, and any custom content or preferences you choose. Prompts, answers and completions are not written to logs. API keys are stored in the iOS Keychain, never in backups, and are sent only to the endpoint they are bound to."
                    )

                    disclosureSection(
                        title: "What stays on this iPad",
                        text: "Your course library, notes, checkpoints and quiz attempts remain in the app's Application Support folder. Generated files are written only after a successful response. A backgrounded or killed request is marked interrupted and never saved as complete."
                    )

                    disclosureSection(
                        title: "Data handling",
                        text: "The provider receives the request over the configured endpoint (HTTPS for DeepSeek and GLM; a LAN model may use HTTP) and may retain it under its own terms and data-residency policy. Do not enable AI generation for material you are not permitted to share with that provider."
                    )

                    Text("You can change this later by removing the model card or re-importing the app data. Declining leaves all reading and editing features available.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(24)
                .frame(maxWidth: 680, alignment: .leading)
            }
            .navigationTitle("Before enabling AI")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Not now") { onNotNow() }
                        .accessibilityIdentifier("aiConsent.notNow")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Accept") { onAccept() }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("aiConsent.accept")
                }
            }
        }
        .interactiveDismissDisabled()
        .accessibilityIdentifier("aiConsent.root")
    }

    private func disclosureSection(title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.headline)
            Text(text).font(.callout)
                .foregroundStyle(.secondary)
        }
    }
}
