import SwiftUI

struct SettingsView: View {
    @StateObject private var viewModel = SettingsViewModel()

    var body: some View {
        Form {
            Section("Location") {
                if let override = viewModel.profile.locationOverride {
                    HStack {
                        Label(override.name, systemImage: "mappin.circle.fill")
                        Spacer()
                        Button("Clear") { viewModel.clearCityOverride() }
                            .foregroundColor(.red)
                    }
                } else {
                    Label("Using current location", systemImage: "location.fill")
                        .foregroundColor(.secondary)
                }
                NavigationLink("Change city") {
                    CityOverrideView(viewModel: viewModel)
                }
            }

            Section("Dietary Preferences") {
                FlowLayout(spacing: 8) {
                    ForEach(DietaryTag.allCases) { tag in
                        Button {
                            var prefs = Set(viewModel.profile.dietaryPreferences)
                            if tag == .noRestrictions {
                                prefs = [.noRestrictions]
                            } else {
                                prefs.remove(.noRestrictions)
                                if prefs.contains(tag) { prefs.remove(tag) }
                                else { prefs.insert(tag) }
                                if prefs.isEmpty { prefs = [.noRestrictions] }
                            }
                            viewModel.profile.dietaryPreferences = Array(prefs)
                            viewModel.saveProfile()
                        } label: {
                            TagChipView(
                                label: "\(tag.emoji) \(tag.displayName)",
                                isSelected: viewModel.profile.dietaryPreferences.contains(tag)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 4)
            }

            Section("Reservations") {
                Stepper("Default party: \(viewModel.profile.defaultPartySize)",
                        value: Binding(
                            get: { viewModel.profile.defaultPartySize },
                            set: { viewModel.profile.defaultPartySize = $0; viewModel.saveProfile() }
                        ), in: 1...20)
            }

            Section("About") {
                LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
            }
        }
        .navigationTitle("Settings")
    }
}
