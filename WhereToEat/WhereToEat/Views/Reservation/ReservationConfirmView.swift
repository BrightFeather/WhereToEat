import SwiftUI

struct ReservationConfirmView: View {
    let slot: TimeSlot
    @ObservedObject var viewModel: ReservationViewModel

    init(slot: TimeSlot, viewModel: ReservationViewModel) {
        self.slot = slot
        self.viewModel = viewModel
    }

    private let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .full
        f.timeStyle = .short
        return f
    }()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Restaurant photo header
                if let url = viewModel.restaurant.primaryPhotoURL {
                    AsyncImage(url: url) { img in
                        img.resizable().scaledToFill()
                    } placeholder: { Color(.systemGray5) }
                    .frame(height: 180).clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                }

                // Booking summary
                VStack(alignment: .leading, spacing: 12) {
                    Text("Confirm reservation").font(.title3).fontWeight(.bold)

                    infoRow(icon: "fork.knife", label: viewModel.restaurant.name)
                    infoRow(icon: "calendar", label: formatter.string(from: slot.datetime))
                    infoRow(icon: "person.2", label: "\(slot.partySize) people")
                    infoRow(icon: "mappin", label: viewModel.restaurant.address)
                }
                .padding()
                .background(Color(.systemGray6))
                .clipShape(RoundedRectangle(cornerRadius: 16))

                // Deposit info
                if slot.depositRequired, let amount = slot.depositAmount {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Deposit required", systemImage: "creditcard.fill")
                            .font(.headline).foregroundColor(.orange)
                        Text("$\(amount as NSDecimalNumber, formatter: currencyFormatter) will be charged to complete this reservation.")
                            .font(.subheadline).foregroundColor(.secondary)
                        if let policy = slot.depositPolicy {
                            Text(policy).font(.caption).foregroundColor(.secondary)
                        }
                    }
                    .padding()
                    .background(Color.orange.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }

                Spacer(minLength: 20)

                // Confirm button
                Button {
                    Task { await viewModel.confirmBooking(slot: slot) }
                } label: {
                    HStack {
                        if slot.depositRequired {
                            Image(systemName: "applelogo")
                        }
                        Text(slot.depositRequired ? "Pay & Reserve" : "Confirm Reservation")
                            .font(.headline)
                    }
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.accentColor)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                }

                Button("Choose a different time") {
                    viewModel.state = .selectingSlot
                }
                .font(.subheadline)
                .foregroundColor(.secondary)
                .frame(maxWidth: .infinity)
            }
            .padding()
        }
    }

    private func infoRow(icon: String, label: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).foregroundColor(.accentColor).frame(width: 20)
            Text(label).font(.subheadline)
        }
    }

    private var currencyFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 2
        return f
    }()
}
