import SwiftUI

struct AvailabilityView: View {
    @StateObject var viewModel: ReservationViewModel
    @Environment(\.dismiss) private var dismiss

    private let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEEE, MMM d"
        return f
    }()
    private let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .short
        return f
    }()

    var body: some View {
        Group {
            switch viewModel.state {
            case .selectingSlot:
                slotSelectionView
            case .confirming(let slot):
                ReservationConfirmView(slot: slot, viewModel: viewModel)
            case .processingPayment:
                processingView
            case .success(let reservation):
                ReservationSuccessView(reservation: reservation, restaurant: viewModel.restaurant) {
                    dismiss()
                }
            case .failed(let message):
                errorView(message)
            case .noAvailability:
                noAvailabilityView
            }
        }
        .navigationTitle(viewModel.restaurant.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await viewModel.loadAvailability() }
    }

    private var slotSelectionView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Party size + date controls
                HStack {
                    Label("Party size", systemImage: "person.2")
                    Spacer()
                    Stepper("\(viewModel.partySize)", value: $viewModel.partySize, in: 1...20)
                        .onChange(of: viewModel.partySize) { _, _ in
                            Task { await viewModel.loadAvailability() }
                        }
                }
                .padding()
                .background(Color(.systemGray6))
                .clipShape(RoundedRectangle(cornerRadius: 12))

                if viewModel.isLoadingSlots {
                    HStack { Spacer(); ProgressView("Checking availability…"); Spacer() }
                        .padding()
                } else {
                    ForEach(viewModel.slotsByDay, id: \.date) { group in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(dayFormatter.string(from: group.date))
                                .font(.headline)

                            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 10) {
                                ForEach(group.slots) { slot in
                                    Button { viewModel.selectSlot(slot) } label: {
                                        VStack(spacing: 2) {
                                            Text(timeFormatter.string(from: slot.datetime))
                                                .font(.subheadline).fontWeight(.medium)
                                            if slot.depositRequired {
                                                Text("Deposit")
                                                    .font(.caption2).foregroundColor(.orange)
                                            }
                                        }
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 10)
                                        .background(Color.accentColor.opacity(0.08))
                                        .foregroundColor(.accentColor)
                                        .clipShape(RoundedRectangle(cornerRadius: 10))
                                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentColor.opacity(0.3)))
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
            }
            .padding()
        }
    }

    private var processingView: some View {
        VStack(spacing: 20) {
            ProgressView()
            Text("Processing payment…").foregroundColor(.secondary)
        }
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 20) {
            Image(systemName: "exclamationmark.circle").font(.system(size: 50)).foregroundColor(.red)
            Text("Something went wrong").font(.title3).fontWeight(.semibold)
            Text(message).foregroundColor(.secondary).multilineTextAlignment(.center)
            Button("Try again") {
                viewModel.state = .selectingSlot
                Task { await viewModel.loadAvailability() }
            }
            .buttonStyle(.bordered)
            Button("Back to restaurants") { dismiss() }
                .foregroundColor(.secondary)
        }
        .padding()
    }

    private var noAvailabilityView: some View {
        VStack(spacing: 20) {
            Image(systemName: "calendar.badge.exclamationmark").font(.system(size: 50)).foregroundColor(.orange)
            Text("No availability").font(.title3).fontWeight(.semibold)
            Text("There are no open slots for your selected dates. Try adjusting the party size or check back later.")
                .foregroundColor(.secondary).multilineTextAlignment(.center)
            Button("Back to restaurants") { dismiss() }
                .buttonStyle(.bordered)
        }
        .padding()
    }
}
