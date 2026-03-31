import SwiftUI

struct HomeView: View {
    @StateObject private var viewModel = HomeViewModel()
    @StateObject private var customListVM = CustomListViewModel()
    @EnvironmentObject private var locationService: LocationService

    var body: some View {
        TabView {
            NavigationStack {
                mainTab
                    .navigationTitle("WhereToEat")
                    .toolbar {
                        ToolbarItem(placement: .navigationBarTrailing) {
                            NavigationLink(destination: SettingsView()) {
                                Image(systemName: "gearshape")
                            }
                        }
                    }
                    .navigationDestination(isPresented: $viewModel.navigateToDiscovery) {
                        let session = viewModel.weeklySession
                        let vm = DiscoveryViewModel(session: session, customList: customListVM.restaurants)
                        DiscoveryContainerView(viewModel: vm)
                    }
            }
            .tabItem { Label("Home", systemImage: "house.fill") }

            NavigationStack {
                CustomListView()
                    .navigationTitle("My List")
            }
            .tabItem { Label("My List", systemImage: "list.star") }
        }
        .sheet(isPresented: $viewModel.showCuisinePrompt) {
            WeeklyCuisinePromptView { cuisines in
                viewModel.setCuisinesAndStartDiscovery(cuisines)
            }
        }
        .onAppear { viewModel.refresh() }
    }

    private var mainTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Location banner
                if locationService.isUsingOverride {
                    HStack {
                        Image(systemName: "mappin.circle.fill").foregroundColor(.orange)
                        Text("Showing restaurants in \(locationService.effectiveCityName)")
                            .font(.subheadline).foregroundColor(.secondary)
                        Spacer()
                    }
                    .padding(.horizontal)
                }

                // Weekly CTA card
                weeklyCard

                // Upcoming reservations
                if viewModel.hasUpcomingReservations {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Upcoming").font(.headline).padding(.horizontal)
                        ForEach(viewModel.upcomingReservations) { reservation in
                            ReservationRowView(reservation: reservation)
                                .padding(.horizontal)
                        }
                    }
                }
            }
            .padding(.vertical)
        }
    }

    private var weeklyCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let message = viewModel.bannerMessage {
                Text(message)
                    .font(.title3).fontWeight(.semibold)

                HStack(spacing: 12) {
                    Button(action: viewModel.startDiscovery) {
                        Text("Pick restaurants")
                            .font(.headline)
                            .foregroundColor(.white)
                            .frame(maxWidth: .infinity)
                            .padding()
                            .background(Color.accentColor)
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                    }
                    Button(action: viewModel.skipThisWeek) {
                        Text("Skip this week")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                }
            } else if viewModel.weeklySession.status == .skipped {
                Text("You skipped this week.")
                    .foregroundColor(.secondary)
                Button("Pick anyway") { viewModel.startDiscovery() }
                    .buttonStyle(.bordered)
            } else if viewModel.weeklySession.status == .completed {
                HStack {
                    Image(systemName: "checkmark.circle.fill").foregroundColor(.green)
                    Text("Reservation locked in!").fontWeight(.semibold)
                }
            }
        }
        .padding()
        .background(Color(.systemGray6))
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .padding(.horizontal)
    }
}

struct ReservationRowView: View {
    let reservation: Reservation
    private let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(reservation.restaurantName).fontWeight(.semibold)
                Text(formatter.string(from: reservation.datetime))
                    .font(.subheadline).foregroundColor(.secondary)
                Text("\(reservation.partySize) people · \(reservation.platform.displayName)")
                    .font(.caption).foregroundColor(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right").foregroundColor(.secondary)
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }
}

struct DiscoveryContainerView: View {
    @ObservedObject var viewModel: DiscoveryViewModel
    @State private var showReservation: Bool = false

    var body: some View {
        CardDeckView(viewModel: viewModel)
            .navigationTitle("This Weekend")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(item: $viewModel.likedRestaurant) { restaurant in
                NavigationStack {
                    AvailabilityView(viewModel: ReservationViewModel(restaurant: restaurant))
                }
            }
    }
}
