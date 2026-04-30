import SwiftUI

/// First-launch welcome screen. Shown once, gated by
/// `@AppStorage("has_seen_welcome")`. One tap past — no multi-page flow,
/// since onboarding (party size / dietary) is intentionally skipped.
///
/// Visual recipe: warm gradient (shared `WarmGradientBackground`), a
/// breathing logo, serif wordmark, cuisine "polaroids" that fan in with a
/// staggered spring, and a purple→orange gradient CTA. Keeps the app's
/// "food magazine" tone from the first frame.
struct WelcomeView: View {
    var onContinue: () -> Void

    @State private var logoScale: CGFloat = 0.6
    @State private var logoOpacity: Double = 0
    @State private var titleOffset: CGFloat = 24
    @State private var titleOpacity: Double = 0
    @State private var subtitleOpacity: Double = 0
    @State private var polaroidsVisible: Bool = false
    @State private var ctaOffset: CGFloat = 36
    @State private var ctaOpacity: Double = 0
    @State private var breathing: Bool = false

    private let polaroids: [Polaroid] = [
        Polaroid(
            emoji: "🍣", label: "Japanese",
            gradient: [
                Color(red: 1.00, green: 0.75, blue: 0.78),
                Color(red: 0.92, green: 0.45, blue: 0.55)
            ],
            rotation: -10
        ),
        Polaroid(
            emoji: "🍝", label: "Italian",
            gradient: [
                Color(red: 1.00, green: 0.85, blue: 0.60),
                Color(red: 0.95, green: 0.55, blue: 0.25)
            ],
            rotation: 0
        ),
        Polaroid(
            emoji: "🌮", label: "Mexican",
            gradient: [
                Color(red: 0.95, green: 0.80, blue: 0.50),
                Color(red: 0.80, green: 0.45, blue: 0.20)
            ],
            rotation: 10
        )
    ]

    struct Polaroid {
        let emoji: String
        let label: String
        let gradient: [Color]
        let rotation: Double
    }

    var body: some View {
        ZStack {
            WarmGradientBackground().ignoresSafeArea()

            VStack(spacing: 28) {
                Spacer(minLength: 24)

                logo
                wordmark
                polaroidRow

                Spacer()

                cta
                fineprint
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 32)
        }
        .onAppear(perform: startAnimation)
    }

    // MARK: - Pieces

    private var logo: some View {
        Image(systemName: "fork.knife.circle.fill")
            .font(.system(size: 96, weight: .bold))
            .foregroundStyle(
                Color(red: 0.98, green: 0.48, blue: 0.10),
                Color(red: 1.00, green: 0.91, blue: 0.80)
            )
            .shadow(color: Color(red: 0.98, green: 0.48, blue: 0.10).opacity(0.35), radius: 18, y: 6)
            .scaleEffect(logoScale * (breathing ? 1.04 : 1.0))
            .opacity(logoOpacity)
    }

    private var wordmark: some View {
        VStack(spacing: 8) {
            Text("WhereToEat")
                .font(.system(size: 44, weight: .black, design: .serif))
                .foregroundColor(.primary)
                .offset(y: titleOffset)
                .opacity(titleOpacity)

            Text("Curated NYC picks,\nfresh from Xiaohongshu creators.")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .lineSpacing(2)
                .opacity(subtitleOpacity)
        }
    }

    private var polaroidRow: some View {
        HStack(spacing: 14) {
            ForEach(polaroids.indices, id: \.self) { i in
                polaroidCard(polaroids[i], index: i)
            }
        }
        .padding(.vertical, 8)
    }

    private func polaroidCard(_ p: Polaroid, index: Int) -> some View {
        VStack(spacing: 0) {
            ZStack {
                LinearGradient(
                    colors: p.gradient,
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                Text(p.emoji)
                    .font(.system(size: 42))
            }
            .frame(width: 92, height: 102)

            Text(p.label)
                .font(.caption).fontWeight(.semibold)
                .foregroundColor(.primary)
                .frame(width: 92, height: 28)
                .background(Color(.systemBackground))
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.14), radius: 10, y: 4)
        .rotationEffect(.degrees(p.rotation))
        .scaleEffect(polaroidsVisible ? 1.0 : 0.5)
        .opacity(polaroidsVisible ? 1.0 : 0)
        .animation(
            .spring(response: 0.55, dampingFraction: 0.65)
                .delay(0.55 + Double(index) * 0.12),
            value: polaroidsVisible
        )
    }

    private var cta: some View {
        Button(action: onContinue) {
            HStack(spacing: 10) {
                Text("Let's pick")
                    .font(.headline)
                Image(systemName: "arrow.right")
                    .font(.subheadline).fontWeight(.bold)
            }
            .foregroundColor(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(
                LinearGradient(
                    colors: [
                        Color(red: 0.45, green: 0.20, blue: 0.95),
                        Color(red: 0.98, green: 0.48, blue: 0.10)
                    ],
                    startPoint: .leading, endPoint: .trailing
                )
            )
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .shadow(color: Color(red: 0.98, green: 0.48, blue: 0.10).opacity(0.35),
                    radius: 12, y: 4)
        }
        .buttonStyle(.plain)
        .offset(y: ctaOffset)
        .opacity(ctaOpacity)
    }

    private var fineprint: some View {
        Text("Over 100 spots · bookable on Resy & OpenTable")
            .font(.caption2)
            .foregroundColor(.secondary)
            .multilineTextAlignment(.center)
            .opacity(ctaOpacity)
    }

    // MARK: - Animation timeline

    private func startAnimation() {
        withAnimation(.spring(response: 0.6, dampingFraction: 0.6)) {
            logoScale = 1.0
            logoOpacity = 1.0
        }
        withAnimation(.easeOut(duration: 0.5).delay(0.2)) {
            titleOffset = 0
            titleOpacity = 1.0
        }
        withAnimation(.easeOut(duration: 0.5).delay(0.4)) {
            subtitleOpacity = 1.0
        }
        // Polaroids animate via their own `.animation(...)` modifier; just
        // flip the flag to kick them off.
        polaroidsVisible = true
        withAnimation(.spring(response: 0.55, dampingFraction: 0.8).delay(1.15)) {
            ctaOffset = 0
            ctaOpacity = 1.0
        }
        // Continuous "breathing" on the logo — subtle scale pulse on a slow
        // loop so the screen isn't static while the user reads.
        withAnimation(.easeInOut(duration: 2.4).repeatForever(autoreverses: true)) {
            breathing = true
        }
    }
}
