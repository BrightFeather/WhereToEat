import SwiftUI

struct PhotoCarouselView: View {
    let photoURLs: [URL]
    var height: CGFloat = 280

    @State private var currentPage: Int = 0

    var body: some View {
        if photoURLs.isEmpty {
            Rectangle()
                .fill(Color(.systemGray5))
                .frame(height: height)
                .overlay(Image(systemName: "fork.knife").font(.largeTitle).foregroundColor(.secondary))
        } else {
            TabView(selection: $currentPage) {
                ForEach(Array(photoURLs.enumerated()), id: \.offset) { index, url in
                    CachedAsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFill()
                        case .failure:
                            Color(.systemGray5)
                                .overlay(Image(systemName: "photo").foregroundColor(.secondary))
                        case .empty:
                            Color(.systemGray6)
                                .overlay(ProgressView())
                        @unknown default:
                            Color(.systemGray6)
                        }
                    }
                    .clipped()
                    .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: photoURLs.count > 1 ? .automatic : .never))
            .frame(height: height)
        }
    }
}
