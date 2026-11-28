import SwiftUI

struct SettingsView: View {
    @StateObject private var viewModel = SettingsViewModel()
    @ObservedObject private var auth = AuthService.shared
    @AppStorage("auth_gate_dismissed") private var authGateDismissed: Bool = false
    @EnvironmentObject private var locationService: LocationService
    @ObservedObject private var weekly = WeeklyRestaurantService.shared
    @AppStorage(AppAppearance.storageKey) private var appearance: AppAppearance = .light

    var body: some View {
        Form {
            Section {
                cityRow(key: nil, label: "Current location",
                        subtitle: weekly.gpsCity.flatMap(Self.cityLabel).map { "Near \($0)" }
                            ?? "Not near a supported city · New York")
                ForEach(WeeklyRestaurantService.cities, id: \.key) { city in
                    cityRow(key: city.key, label: city.label, subtitle: Self.citySubtitles[city.key] ?? "")
                }
                // Free-form overrides from older builds still steer the GPS
                // coordinates; let the user clear one.
                if let override = viewModel.profile.locationOverride {
                    HStack {
                        Label(override.name, systemImage: "mappin.circle.fill")
                        Spacer()
                        Button("Clear") { viewModel.clearCityOverride() }
                            .foregroundColor(.red)
                    }
                }
            } header: {
                Text("City")
            } footer: {
                Text("Home, Pick and Find show restaurants from this city.")
            }
            .listRowBackground(Color.homeBgBottom)

            Section {
                Picker("Appearance", selection: $appearance) {
                    ForEach(AppAppearance.allCases) { option in
                        Text(option.label).tag(option)
                    }
                }
                .pickerStyle(.segmented)
            } header: {
                Text("Appearance")
            }
            .listRowBackground(Color.homeBgBottom)

            // Dietary Preferences — commented out per user request
            // (the data isn't wired into filtering yet, so the section was
            // taking up space without affecting results). Restore by
            // uncommenting if/when the filter pipeline starts honoring
            // `viewModel.profile.dietaryPreferences`.
            //
            // Section("Dietary Preferences") {
            //     FlowLayout(spacing: 8) {
            //         ForEach(DietaryTag.allCases) { tag in
            //             Button {
            //                 var prefs = Set(viewModel.profile.dietaryPreferences)
            //                 if tag == .noRestrictions {
            //                     prefs = [.noRestrictions]
            //                 } else {
            //                     prefs.remove(.noRestrictions)
            //                     if prefs.contains(tag) { prefs.remove(tag) }
            //                     else { prefs.insert(tag) }
            //                     if prefs.isEmpty { prefs = [.noRestrictions] }
            //                 }
            //                 viewModel.profile.dietaryPreferences = Array(prefs)
            //                 viewModel.saveProfile()
            //             } label: {
            //                 TagChipView(
            //                     label: "\(tag.emoji) \(tag.displayName)",
            //                     isSelected: viewModel.profile.dietaryPreferences.contains(tag)
            //                 )
            //             }
            //             .buttonStyle(.plain)
            //         }
            //     }
            //     .padding(.vertical, 4)
            // }
            // .listRowBackground(Color.homeBgBottom)

            Section {
                Stepper("Default party: \(viewModel.profile.defaultPartySize)",
                        value: Binding(
                            get: { viewModel.profile.defaultPartySize },
                            set: { viewModel.profile.defaultPartySize = $0; viewModel.saveProfile() }
                        ), in: 1...20)

                Toggle("Only show bookable restaurants", isOn: Binding(
                    get: { viewModel.profile.showOnlyReservable },
                    set: { viewModel.profile.showOnlyReservable = $0; viewModel.saveProfile() }
                ))
            } header: {
                Text("Reservations")
            } footer: {
                Text(viewModel.profile.showOnlyReservable
                     ? "Only restaurants bookable on Resy or OpenTable will appear."
                     : "Unreservable restaurants will show up too. Their card's button becomes \"Go to Website\".")
            }
            .listRowBackground(Color.homeBgBottom)

            Section {
                ForEach(DiscoverySource.allCases) { source in
                    Toggle(source.displayName, isOn: Binding(
                        get: { viewModel.profile.discoverySources.contains(source.rawValue) },
                        set: { isOn in
                            var set = viewModel.profile.discoverySources
                            if isOn { set.insert(source.rawValue) }
                            else    { set.remove(source.rawValue) }
                            viewModel.profile.discoverySources = set
                            viewModel.saveProfile()
                        }
                    ))
                }
            } header: {
                Text("Recommendation Sources")
            } footer: {
                Text(viewModel.profile.discoverySources.isEmpty
                     ? "Pick at least one source — your home and Discovery feed are empty until you do."
                     : "Restaurants must have at least one review from one of the selected sources to appear on Home and Discovery.")
            }
            .listRowBackground(Color.homeBgBottom)

            Section {
                Toggle("Show Google ratings", isOn: Binding(
                    get: { viewModel.profile.showRatings },
                    set: { viewModel.profile.showRatings = $0; viewModel.saveProfile() }
                ))
            } header: {
                Text("Display")
            } footer: {
                Text(viewModel.profile.showRatings
                     ? "Restaurant cards show the Google Maps rating (e.g. 4.7★ · 1.2k)."
                     : "Ratings are hidden everywhere — restaurant cards and the detail view.")
            }
            .listRowBackground(Color.homeBgBottom)

            Section("Account") {
                accountSection
            }
            .listRowBackground(Color.homeBgBottom)

            Section {
                NavigationLink {
                    FeedbackView()
                } label: {
                    Label("Send Feedback", systemImage: "envelope")
                }
            }
            .listRowBackground(Color.homeBgBottom)

            Section("About") {
                LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
            }
            .listRowBackground(Color.homeBgBottom)
        }
        .scrollContentBackground(.hidden)
        .background(WarmGradientBackground().ignoresSafeArea())
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.large)
    }

    private static let citySubtitles = ["nyc": "5 boroughs", "bay": "SF & the Bay"]

    private static func cityLabel(_ key: String) -> String? {
        WeeklyRestaurantService.cities.first { $0.key == key }?.label
    }

    /// One city choice. `key == nil` is "Current location" (follow GPS).
    /// Picking a city also clears any legacy free-form override.
    private func cityRow(key: String?, label: String, subtitle: String) -> some View {
        let isSelected = key == nil ? weekly.isAutoCity : (!weekly.isAutoCity && weekly.activeCity == key)
        return Button {
            if let key { weekly.selectCity(key) } else { weekly.useCurrentLocation() }
            if viewModel.profile.locationOverride != nil { viewModel.clearCityOverride() }
        } label: {
            HStack {
                Image(systemName: key == nil ? "location.fill" : "building.2")
                    .foregroundColor(LuckyCard.orange)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 1) {
                    Text(label).foregroundColor(.primary)
                    if !subtitle.isEmpty {
                        Text(subtitle).font(.caption).foregroundColor(.secondary)
                    }
                }
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark")
                        .fontWeight(.semibold)
                        .foregroundColor(LuckyCard.orange)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    @ViewBuilder
    private var accountSection: some View {
        switch auth.state {
        case .authenticated(_, let name, let provider):
            LabeledContent("Signed in with", value: provider.capitalized)
            if let name { LabeledContent("Name", value: name) }
            Button(role: .destructive) {
                auth.signOut()
                // Re-prompt the login gate on next Home visit so the user can
                // switch accounts without reinstalling.
                authGateDismissed = false
            } label: {
                Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
            }
        case .anonymous:
            Text("You're using WhereToEat as a guest.")
                .font(.footnote).foregroundColor(.secondary)
            Button {
                authGateDismissed = false
            } label: {
                Label("Sign in with Apple", systemImage: "person.crop.circle.badge.plus")
            }
        }
    }
}
