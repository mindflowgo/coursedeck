import CourseDeckCore
import SwiftUI

struct ModelCardEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var services: AppServices

    let original: LlmModelCard?
    let onSaved: () -> Void

    @State private var label: String
    @State private var provider: String
    @State private var baseURL: String
    @State private var model: String
    @State private var authHeader: LlmModelCard.AuthHeaderType
    @State private var temperature: Double
    @State private var maxTokens: Int
    @State private var thinking: Bool
    @State private var idleSeconds: Int
    @State private var apiKey = ""
    @State private var errorMessage: String?
    @State private var isSaving = false
    @State private var showingDeleteConfirmation = false
    private let hasStoredKey: Bool

    init(
        card: LlmModelCard?,
        extensions: LlmCardExtensions?,
        hasStoredKey: Bool,
        onSaved: @escaping () -> Void
    ) {
        self.original = card
        self.onSaved = onSaved
        self.hasStoredKey = hasStoredKey
        _label = State(initialValue: card?.label ?? "")
        _provider = State(initialValue: card?.provider ?? "openai_compatible")
        _baseURL = State(initialValue: card?.baseUrl ?? "https://api.deepseek.com")
        _model = State(initialValue: card?.model ?? "deepseek-flash")
        _authHeader = State(initialValue: card?.authHeaderType ?? .bearer)
        _temperature = State(initialValue: card?.temperature ?? 0.3)
        _maxTokens = State(initialValue: extensions?.maxTokens ?? LlmCardExtensions.defaultMaxTokens)
        _thinking = State(initialValue: extensions?.thinking ?? false)
        _idleSeconds = State(initialValue: extensions?.idleTimeoutSeconds ?? 60)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Card") {
                    TextField("Label", text: $label)
                        .accessibilityIdentifier("modelCard.label")
                    Picker("Provider", selection: $provider) {
                        Text("OpenAI-compatible").tag("openai_compatible")
                        Text("LM Studio (local)").tag("lmstudio")
                        Text("Ollama (local)").tag("ollama")
                        Text("llama.cpp (local)").tag("llamacpp")
                        Text("Google Gemini").tag("gemini")
                    }
                    TextField("Base URL", text: $baseURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("modelCard.baseURL")
                    TextField("Model", text: $model)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("modelCard.model")
                    Picker("Auth header", selection: $authHeader) {
                        Text("Bearer").tag(LlmModelCard.AuthHeaderType.bearer)
                        Text("x-api-key").tag(LlmModelCard.AuthHeaderType.apiKey)
                        Text("Both").tag(LlmModelCard.AuthHeaderType.both)
                    }
                }

                Section("Key") {
                    if hasStoredKey {
                        Label("A key is stored in the Keychain for this endpoint.", systemImage: "key.fill")
                            .foregroundStyle(.green)
                        Button("Remove stored key", role: .destructive) {
                            Task {
                                guard let original else { return }
                                do {
                                    try await services.clearModelKey(id: original.id)
                                    onSaved()
                                } catch {
                                    errorMessage = error.localizedDescription
                                }
                            }
                        }
                    }
                    SecureField(hasStoredKey ? "New key (leave blank to keep the stored key)" : "API key", text: $apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("modelCard.apiKey")
                    Text("Keys are stored in the iOS Keychain, never in llm_config.json or backups.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Generation limits") {
                    HStack {
                        Text("Temperature")
                        Slider(value: $temperature, in: 0...1.5, step: 0.1)
                        Text(String(format: "%.1f", temperature)).monospacedDigit()
                    }
                    Stepper("Max tokens: \(maxTokens)", value: $maxTokens, in: 1_024...65_536, step: 1_024)
                    Toggle("Thinking (DeepSeek only)", isOn: $thinking)
                    Stepper("Idle timeout: \(idleSeconds)s", value: $idleSeconds, in: 15...600, step: 15)
                    Text("The idle timeout is the stream-stall limit. The absolute safety cap is 900 seconds.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                }

                if original != nil {
                    Section {
                        Button("Delete card", role: .destructive) {
                            showingDeleteConfirmation = true
                        }
                    }
                }
            }
            .navigationTitle(original == nil ? "Add model card" : "Edit model card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(isSaving || label.trimmingCharacters(in: .whitespaces).isEmpty || baseURL.isEmpty || model.isEmpty)
                        .accessibilityIdentifier("modelCard.save")
                }
            }
            .alert("Delete this model card?", isPresented: $showingDeleteConfirmation) {
                Button("Delete", role: .destructive) { deleteCard() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The Keychain item for this card and endpoint is deleted.")
            }
            .accessibilityIdentifier("modelCard.root")
        }
    }

    private func save() {
        isSaving = true
        errorMessage = nil
        Task {
            let card = LlmModelCard(
                id: original?.id ?? "",
                label: label.trimmingCharacters(in: .whitespacesAndNewlines),
                provider: provider,
                baseUrl: baseURL.trimmingCharacters(in: .whitespacesAndNewlines),
                authHeaderType: authHeader,
                model: model.trimmingCharacters(in: .whitespacesAndNewlines),
                temperature: temperature,
                timeoutSeconds: idleSeconds,
                sendSessionId: original?.sendSessionId ?? false,
                extras: original?.extras ?? []
            )
            let extensions = LlmCardExtensions(
                maxTokens: maxTokens,
                thinking: thinking,
                idleTimeoutSeconds: idleSeconds
            )
            do {
                try await services.saveModelCard(
                    card,
                    key: apiKey.trimmingCharacters(in: .whitespacesAndNewlines),
                    extensions: extensions
                )
                onSaved()
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }

    private func deleteCard() {
        guard let original else { return }
        Task {
            do {
                try await services.deleteModelCard(id: original.id)
                onSaved()
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
