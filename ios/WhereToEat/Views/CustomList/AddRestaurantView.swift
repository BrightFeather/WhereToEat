import SwiftUI

struct AddRestaurantView: View {
    @ObservedObject var viewModel: CustomListViewModel
    @State private var urlText = ""
    @State private var showUnderDevelopmentAlert = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Paste a link").font(.headline)
                    Text("Paste a URL or share text from Google Maps, Yelp, Xiaohongshu, or any restaurant website.")
                        .font(.subheadline).foregroundColor(.secondary)

                    HStack {
                        TextField("Paste link or text containing a link", text: $urlText)
                            .keyboardType(.URL)
                            .autocapitalization(.none)
                            .padding()
                            .background(Color(.systemGray6))
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        if !urlText.isEmpty {
                            Button { urlText = "" } label: {
                                Image(systemName: "xmark.circle.fill").foregroundColor(.secondary)
                            }
                        }
                    }
                }

                if let error = viewModel.importError {
                    HStack {
                        Image(systemName: "exclamationmark.circle").foregroundColor(.red)
                        Text(error).font(.subheadline).foregroundColor(.red)
                    }
                }

                Button {
                    // Paste-link import is being rebuilt for a non-blocking
                    // async UX (see TASKS.md § XHS link import async redesign).
                    // For now, surface a clear "under development" alert
                    // instead of kicking off the parse — the previous flow
                    // could hang on the parsing popup for 10+ seconds and
                    // there was no recovery if the backend timed out.
                    showUnderDevelopmentAlert = true

                    // Original import action — keep wired for fast re-enable.
                    // Restore by deleting the line above and uncommenting:
                    //
                    // let url = Self.extractURL(from: urlText) ?? urlText
                    // Task {
                    //     await viewModel.importURL(url)
                    //     // Either preview flavor means the parse succeeded — close
                    //     // the Add sheet so the preview sheet can present cleanly.
                    //     if viewModel.showImportPreview || viewModel.showXhsImportPreview {
                    //         dismiss()
                    //     }
                    // }
                } label: {
                    Text("Import")
                        .font(.headline).foregroundColor(.white)
                        .frame(maxWidth: .infinity).padding()
                        .background(urlText.isEmpty ? Color.secondary : Color.accentColor)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                }
                .disabled(urlText.isEmpty || viewModel.isImporting)

                Divider()

                VStack(alignment: .leading, spacing: 8) {
                    Text("Or share from another app").font(.headline)
                    Text("Tap the share button in Google Maps, Yelp, or Xiaohongshu → tap WhereToEat.")
                        .font(.subheadline).foregroundColor(.secondary)
                }

                Spacer()
            }
            .padding()
            .navigationTitle("Add Restaurant")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { dismiss() }
                        .disabled(viewModel.isImporting)
                }
            }
            .overlay {
                if viewModel.isImporting {
                    ParsingPopup()
                        .transition(.opacity.combined(with: .scale(scale: 0.95)))
                }
            }
            .animation(.easeInOut(duration: 0.15), value: viewModel.isImporting)
            .alert("Coming soon", isPresented: $showUnderDevelopmentAlert) {
                Button("Got it", role: .cancel) { }
            } message: {
                Text("Saving restaurants by pasting a link is under development. For now, save spots by tapping the bookmark on any Pick or Find card.")
            }
        }
    }

}

/// Full-sheet overlay shown while the backend resolves + enriches the link.
/// Runs during CustomListViewModel.isImporting (XHS flow round-trips Google
/// Places + Resy + OpenTable lookups, which can take several seconds).
private struct ParsingPopup: View {
    var body: some View {
        ZStack {
            Color.black.opacity(0.35).ignoresSafeArea()

            VStack(spacing: 16) {
                ProgressView()
                    .scaleEffect(1.3)
                    .tint(.accentColor)

                Text("Parsing restaurant info…")
                    .font(.headline)

                Text("Pulling names, photos, and booking links.\nThis may take a few seconds.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(28)
            .frame(maxWidth: 280)
            .background(.ultraThickMaterial, in: RoundedRectangle(cornerRadius: 18))
            .shadow(color: .black.opacity(0.25), radius: 20, y: 8)
        }
    }
}

extension AddRestaurantView {
    static func extractURL(from text: String) -> String? {
        // XHS share text wraps the link in Chinese copy/emoji, which confuses
        // NSDataDetector. Try the XHS-specific parser first so pastes like
        // "98 【小红书】 … http://xhslink.com/a/abc" still land on the XHS flow.
        if let xhsURL = XHSURLParser.extract(from: text) {
            return xhsURL.absoluteString
        }
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return nil
        }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = detector.firstMatch(in: text, range: range),
              let urlRange = Range(match.range, in: text) else {
            return nil
        }
        return String(text[urlRange])
    }
}
