import SwiftUI

struct ReservationSuccessView: View {
    let reservation: Reservation
    let restaurant: Restaurant
    var onDone: () -> Void

    @State private var checkmarkScale: CGFloat = 0.3
    @State private var checkmarkOpacity: Double = 0
    @State private var contentOffset: CGFloat = 40
    @State private var contentOpacity: Double = 0
    @State private var particles: [ConfettiParticle] = []

    private let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .full
        f.timeStyle = .short
        return f
    }()

    private let headlineFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEE, MMM d 'at' h:mm a"
        return f
    }()

    var body: some View {
        ZStack {
            // Confetti particles
            ForEach(particles) { p in
                Circle()
                    .fill(p.color)
                    .frame(width: p.size, height: p.size)
                    .position(x: p.x, y: p.y)
                    .opacity(p.opacity)
            }

            VStack(spacing: 28) {
                Spacer()

                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 80))
                    .foregroundColor(.green)
                    .scaleEffect(checkmarkScale)
                    .opacity(checkmarkOpacity)

                VStack(spacing: 10) {
                    Text("You're all set!")
                        .font(.largeTitle).fontWeight(.bold)
                    (
                        Text("for your reservation at ")
                            .foregroundColor(.secondary)
                        + Text(restaurant.name)
                            .fontWeight(.semibold)
                            .foregroundColor(.primary)
                        + Text(" on ")
                            .foregroundColor(.secondary)
                        + Text(headlineFormatter.string(from: reservation.datetime))
                            .fontWeight(.semibold)
                            .foregroundColor(.primary)
                    )
                    .font(.body)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 24)
                }
                .offset(y: contentOffset)
                .opacity(contentOpacity)

                VStack(spacing: 12) {
                    confirmationRow(icon: "calendar", text: formatter.string(from: reservation.datetime))
                    confirmationRow(icon: "person.2", text: "\(reservation.partySize) people")
                    if reservation.confirmationCode != "—" {
                        confirmationRow(icon: "number", text: "Confirmation: \(reservation.confirmationCode)")
                    }
                    confirmationRow(icon: "mappin", text: restaurant.address)
                }
                .padding()
                .background(Color(.systemGray6))
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .padding(.horizontal)
                .offset(y: contentOffset)
                .opacity(contentOpacity)

                Text("A reminder has been set for the day before.")
                    .font(.subheadline).foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
                    .offset(y: contentOffset)
                    .opacity(contentOpacity)

                Spacer()

                Button(action: onDone) {
                    Text("Done")
                        .font(.headline)
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.accentColor)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                }
                .padding(.horizontal)
                .padding(.bottom, 32)
                .offset(y: contentOffset)
                .opacity(contentOpacity)
            }
        }
        .onAppear { startAnimation() }
    }

    private func startAnimation() {
        // Checkmark pops in
        withAnimation(.spring(response: 0.5, dampingFraction: 0.6)) {
            checkmarkScale = 1.0
            checkmarkOpacity = 1.0
        }
        // Content slides up
        withAnimation(.spring(response: 0.5, dampingFraction: 0.8).delay(0.25)) {
            contentOffset = 0
            contentOpacity = 1.0
        }
        // Confetti burst
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            launchConfetti()
        }
    }

    private func launchConfetti() {
        let colors: [Color] = [.green, .accentColor, .yellow, .orange, .pink, .purple]
        let screenW = UIScreen.main.bounds.width
        particles = (0..<40).map { i in
            ConfettiParticle(
                id: i,
                x: CGFloat.random(in: 0...screenW),
                y: CGFloat.random(in: -20...100),
                size: CGFloat.random(in: 6...14),
                color: colors.randomElement()!,
                opacity: 1.0
            )
        }
        withAnimation(.easeOut(duration: 1.5)) {
            particles = particles.map { p in
                var updated = p
                updated.y = UIScreen.main.bounds.height + 40
                updated.x += CGFloat.random(in: -60...60)
                updated.opacity = 0
                return updated
            }
        }
    }

    private func confirmationRow(icon: String, text: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon).foregroundColor(.accentColor).frame(width: 20)
            Text(text).font(.subheadline)
            Spacer()
        }
    }
}

struct ConfettiParticle: Identifiable {
    let id: Int
    var x: CGFloat
    var y: CGFloat
    var size: CGFloat
    var color: Color
    var opacity: Double
}
