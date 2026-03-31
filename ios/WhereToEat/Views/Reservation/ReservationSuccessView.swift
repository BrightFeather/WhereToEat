import SwiftUI

struct ReservationSuccessView: View {
    let reservation: Reservation
    let restaurant: Restaurant
    var onDone: () -> Void

    private let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .full
        f.timeStyle = .short
        return f
    }()

    var body: some View {
        VStack(spacing: 28) {
            Spacer()

            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 80))
                .foregroundColor(.green)

            VStack(spacing: 8) {
                Text("You're booked!").font(.title).fontWeight(.bold)
                Text(restaurant.name).font(.title3).foregroundColor(.secondary)
            }

            VStack(spacing: 12) {
                confirmationRow(icon: "calendar", text: formatter.string(from: reservation.datetime))
                confirmationRow(icon: "person.2", text: "\(reservation.partySize) people")
                confirmationRow(icon: "number", text: "Confirmation: \(reservation.confirmationCode)")
                confirmationRow(icon: "mappin", text: restaurant.address)
            }
            .padding()
            .background(Color(.systemGray6))
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .padding(.horizontal)

            Text("A reminder has been set for the day before.")
                .font(.subheadline).foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

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
