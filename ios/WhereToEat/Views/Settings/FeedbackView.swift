import SwiftUI
import UIKit
import PhotosUI

/// Settings → Send Feedback. Lets the user type a free-form message and
/// optionally provide a reply-to email; submits to `/api/feedback` which
/// emails prompt.and.ship@gmail.com via Resend.
///
/// The email field is prefilled from the AuthService display name's email
/// (when signed in) — server also has `users.email` and uses it as the
/// fallback reply-to if the user clears the local field.
struct FeedbackView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var auth = AuthService.shared

    @State private var message: String = ""
    @State private var email: String = ""
    @State private var isSending: Bool = false
    @State private var lastError: String?
    @State private var didSucceed: Bool = false

    /// PhotosPicker selections (raw `PhotosPickerItem`s) and their resolved
    /// JPEG-compressed `Data`. We keep both so removing a thumbnail can
    /// reach into either side without re-loading.
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var photoAttachments: [PhotoAttachment] = []
    @State private var isLoadingPhotos: Bool = false

    private let api = APIClient.shared

    /// Backend cap is `MAX_ATTACHMENT_BYTES` per attachment + an overall
    /// per-message budget (see `backend/api/feedback.ts`). 4 photos × ~1 MB
    /// keeps us comfortably under both.
    private static let maxPhotos = 4
    private static let maxBytesPerPhoto = 1_500_000      // 1.5 MB compressed
    private static let jpegQuality: CGFloat = 0.7

    private struct PhotoAttachment: Identifiable, Equatable {
        let id: String           // matches `PhotosPickerItem.itemIdentifier ?? UUID`
        let filename: String
        let data: Data
        var thumbnail: UIImage?
    }

    private var trimmedMessage: String {
        message.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var canSubmit: Bool {
        !trimmedMessage.isEmpty && !isSending && !isLoadingPhotos
    }

    var body: some View {
        Form {
            Section {
                ZStack(alignment: .topLeading) {
                    if message.isEmpty {
                        Text("What's on your mind? Bug, feature request, anything…")
                            .foregroundColor(.secondary)
                            .padding(.top, 8)
                            .padding(.leading, 4)
                    }
                    TextEditor(text: $message)
                        .frame(minHeight: 180)
                }
            } header: {
                Text("Your feedback")
            }
            .listRowBackground(Color.homeBgBottom)

            Section {
                photoPickerRow
                if !photoAttachments.isEmpty {
                    photoThumbnails
                }
            } header: {
                Text("Photos (optional)")
            } footer: {
                Text("Add up to \(Self.maxPhotos) photos — screenshots, the offending UI, anything that helps.")
            }
            .listRowBackground(Color.homeBgBottom)

            Section {
                TextField("you@example.com", text: $email)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
            } header: {
                Text("Reply-to (optional)")
            } footer: {
                Text("If you'd like a response, leave an email so we can reach you.")
            }
            .listRowBackground(Color.homeBgBottom)

            if let lastError {
                Section {
                    Text(lastError)
                        .font(.footnote)
                        .foregroundColor(.red)
                }
                .listRowBackground(Color.homeBgBottom)
            }
        }
        .scrollContentBackground(.hidden)
        .background(WarmGradientBackground().ignoresSafeArea())
        .navigationTitle("Send Feedback")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await submit() }
                } label: {
                    if isSending { ProgressView() } else { Text("Send").bold() }
                }
                .disabled(!canSubmit)
            }
        }
        .onAppear {
            if email.isEmpty, let prefill = prefillEmail() {
                email = prefill
            }
        }
        .onChange(of: photoItems) { _, newItems in
            Task { await loadPhotos(from: newItems) }
        }
        .alert("Thanks!", isPresented: $didSucceed) {
            Button("OK") { dismiss() }
        } message: {
            Text("We got your feedback.")
        }
    }

    @ViewBuilder
    private var photoPickerRow: some View {
        PhotosPicker(
            selection: $photoItems,
            maxSelectionCount: Self.maxPhotos,
            matching: .images,
            photoLibrary: .shared()
        ) {
            HStack(spacing: 8) {
                Image(systemName: "photo.on.rectangle.angled")
                    .foregroundColor(.accentColor)
                Text(photoAttachments.isEmpty
                     ? "Attach photos"
                     : "Add or replace (\(photoAttachments.count)/\(Self.maxPhotos))")
                    .foregroundColor(.primary)
                Spacer()
                if isLoadingPhotos {
                    ProgressView().scaleEffect(0.8)
                }
            }
        }
    }

    @ViewBuilder
    private var photoThumbnails: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(photoAttachments) { att in
                    ZStack(alignment: .topTrailing) {
                        if let img = att.thumbnail {
                            Image(uiImage: img)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 80, height: 80)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        } else {
                            RoundedRectangle(cornerRadius: 10)
                                .fill(Color(.systemGray5))
                                .frame(width: 80, height: 80)
                                .overlay(Image(systemName: "photo").foregroundColor(.secondary))
                        }
                        Button {
                            removePhoto(id: att.id)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 20))
                                .foregroundStyle(.white, .black.opacity(0.55))
                        }
                        .buttonStyle(.plain)
                        .padding(4)
                    }
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func prefillEmail() -> String? {
        // AuthService doesn't expose email today; fall back to a UserDefaults
        // mirror that the auth-exchange writes (key kept stable for the
        // backend `users.email` echo). Empty/nil → no prefill.
        let cached = UserDefaults.standard.string(forKey: "auth.email")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (cached?.isEmpty ?? true) ? nil : cached
    }

    /// Resolve newly-selected `PhotosPickerItem`s into JPEG-compressed bytes.
    /// We diff against the existing attachments by `itemIdentifier` so a
    /// re-render of the picker doesn't reload photos already in hand, and
    /// dropped items are removed from the attachment list.
    private func loadPhotos(from items: [PhotosPickerItem]) async {
        isLoadingPhotos = true
        defer { isLoadingPhotos = false }

        let keptIds = Set(items.compactMap { $0.itemIdentifier })
        await MainActor.run {
            photoAttachments.removeAll { !keptIds.contains($0.id) }
        }

        for item in items {
            let id = item.itemIdentifier ?? UUID().uuidString
            let alreadyLoaded = await MainActor.run { photoAttachments.contains { $0.id == id } }
            if alreadyLoaded { continue }

            do {
                guard let raw = try await item.loadTransferable(type: Data.self) else { continue }
                guard let attachment = compress(raw, id: id) else { continue }
                await MainActor.run {
                    if !photoAttachments.contains(where: { $0.id == attachment.id }) {
                        photoAttachments.append(attachment)
                    }
                }
            } catch {
                await MainActor.run {
                    lastError = "Couldn't read one of the photos."
                }
            }
        }
    }

    /// Resize-on-overflow + JPEG re-encode loop. UIKit `UIImage.jpegData`
    /// already compresses well; if the user picked a 25 MB ProRAW shot we
    /// halve the dimensions until the encoded blob fits the per-photo cap.
    private func compress(_ raw: Data, id: String) -> PhotoAttachment? {
        guard var image = UIImage(data: raw) else { return nil }
        var data = image.jpegData(compressionQuality: Self.jpegQuality) ?? Data()
        var attempts = 0
        while data.count > Self.maxBytesPerPhoto, attempts < 4 {
            let newSize = CGSize(width: image.size.width * 0.7, height: image.size.height * 0.7)
            UIGraphicsBeginImageContextWithOptions(newSize, false, 1)
            image.draw(in: CGRect(origin: .zero, size: newSize))
            if let resized = UIGraphicsGetImageFromCurrentImageContext() {
                image = resized
            }
            UIGraphicsEndImageContext()
            data = image.jpegData(compressionQuality: Self.jpegQuality) ?? data
            attempts += 1
        }
        guard data.count > 0 else { return nil }
        let thumb = thumbnail(from: image)
        return PhotoAttachment(id: id, filename: "feedback-\(id.prefix(8)).jpg", data: data, thumbnail: thumb)
    }

    private func thumbnail(from image: UIImage) -> UIImage {
        let target: CGFloat = 160
        let aspect = image.size.width / max(image.size.height, 1)
        let size = aspect >= 1
            ? CGSize(width: target, height: target / aspect)
            : CGSize(width: target * aspect, height: target)
        UIGraphicsBeginImageContextWithOptions(size, false, 0)
        defer { UIGraphicsEndImageContext() }
        image.draw(in: CGRect(origin: .zero, size: size))
        return UIGraphicsGetImageFromCurrentImageContext() ?? image
    }

    private func removePhoto(id: String) {
        photoAttachments.removeAll { $0.id == id }
        photoItems.removeAll { $0.itemIdentifier == id }
    }

    private func submit() async {
        guard canSubmit else { return }
        lastError = nil
        isSending = true
        defer { isSending = false }

        var body: [String: Any] = ["message": trimmedMessage]
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedEmail.isEmpty { body["email"] = trimmedEmail }
        if let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
            body["appVersion"] = appVersion
        }
        body["deviceModel"] = UIDevice.current.model
        body["iosVersion"] = UIDevice.current.systemVersion
        if !photoAttachments.isEmpty {
            body["attachments"] = photoAttachments.map { att in
                [
                    "filename": att.filename,
                    "contentType": "image/jpeg",
                    "base64": att.data.base64EncodedString(),
                ] as [String: Any]
            }
        }

        do {
            _ = try await api.request(
                Endpoint.submitFeedback(body: body),
                as: FeedbackResponse.self
            )
            didSucceed = true
        } catch {
            lastError = error.localizedDescription
        }
    }

    private struct FeedbackResponse: Decodable { var sent: Bool }
}
