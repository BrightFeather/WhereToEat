import SwiftUI

struct OnboardingContainerView: View {
    @StateObject private var viewModel = OnboardingViewModel()

    var body: some View {
        VStack {
            switch viewModel.currentStep {
            case .dietary:
                DietaryPreferenceView(viewModel: viewModel)
            case .partySize:
                PartySizeView(viewModel: viewModel)
            case .payment:
                PaymentSetupView(viewModel: viewModel)
            case .notifications:
                NotificationsSetupView(viewModel: viewModel)
            case .location:
                LocationSetupView(viewModel: viewModel)
            }
        }
        .animation(.easeInOut, value: viewModel.currentStep)
    }
}

struct DietaryPreferenceView: View {
    @ObservedObject var viewModel: OnboardingViewModel

    var body: some View {
        OnboardingShell(
            icon: "🍽",
            title: "Any dietary preferences?",
            subtitle: "We'll filter restaurants that match. You can change this anytime.",
            buttonLabel: "Continue"
        ) {
            viewModel.advance()
        } content: {
            FlowLayout(spacing: 10) {
                ForEach(DietaryTag.allCases) { tag in
                    Button {
                        viewModel.toggleDietary(tag)
                    } label: {
                        HStack(spacing: 4) {
                            Text(tag.emoji)
                            Text(tag.displayName)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(viewModel.selectedDietary.contains(tag)
                                    ? Color.accentColor.opacity(0.15) : Color(.systemGray6))
                        .foregroundColor(viewModel.selectedDietary.contains(tag) ? .accentColor : .primary)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

struct PartySizeView: View {
    @ObservedObject var viewModel: OnboardingViewModel

    var body: some View {
        OnboardingShell(
            icon: "👥",
            title: "Default party size?",
            subtitle: "We'll pre-fill this when checking availability.",
            buttonLabel: "Continue"
        ) { viewModel.advance() } content: {
            HStack {
                Button { if viewModel.partySize > 1 { viewModel.partySize -= 1 } } label: {
                    Image(systemName: "minus.circle.fill").font(.title).foregroundColor(.accentColor)
                }
                Text("\(viewModel.partySize)").font(.system(size: 64, weight: .bold)).frame(width: 100)
                Button { if viewModel.partySize < 20 { viewModel.partySize += 1 } } label: {
                    Image(systemName: "plus.circle.fill").font(.title).foregroundColor(.accentColor)
                }
            }
        }
    }
}

struct PaymentSetupView: View {
    @ObservedObject var viewModel: OnboardingViewModel

    var body: some View {
        OnboardingShell(
            icon: "💳",
            title: "Set up payment",
            subtitle: "Used only when a restaurant requires a deposit. Apple Pay is used by default.",
            buttonLabel: "Continue"
        ) { viewModel.advance() } content: {
            VStack(spacing: 12) {
                HStack {
                    Image(systemName: "applelogo").font(.title2)
                    Text("Apple Pay").fontWeight(.semibold)
                    Spacer()
                    Image(systemName: "checkmark.circle.fill").foregroundColor(.green)
                }
                .padding()
                .background(Color(.systemGray6))
                .clipShape(RoundedRectangle(cornerRadius: 12))

                Text("Apple Pay will be used automatically. You'll always see a confirmation before any charge.")
                    .font(.caption).foregroundColor(.secondary).multilineTextAlignment(.center)
            }
        }
    }
}

struct NotificationsSetupView: View {
    @ObservedObject var viewModel: OnboardingViewModel

    var body: some View {
        OnboardingShell(
            icon: "🔔",
            title: "Stay in the loop",
            subtitle: "We'll remind you every Monday to pick your weekend restaurants — and alert you the day before your booking.",
            buttonLabel: "Enable Notifications"
        ) {
            Task { await viewModel.requestNotifications(); viewModel.advance() }
        } content: {
            EmptyView()
        }
    }
}

struct LocationSetupView: View {
    @ObservedObject var viewModel: OnboardingViewModel

    var body: some View {
        OnboardingShell(
            icon: "📍",
            title: "Find restaurants near you",
            subtitle: "We use your location to show the best nearby options each week.",
            buttonLabel: "Allow Location Access"
        ) {
            viewModel.requestLocation()
            viewModel.advance()
        } content: {
            EmptyView()
        }
    }
}

// Shared onboarding chrome
struct OnboardingShell<Content: View>: View {
    let icon: String
    let title: String
    let subtitle: String
    let buttonLabel: String
    let onContinue: () -> Void
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 32) {
            Spacer()
            Text(icon).font(.system(size: 64))
            VStack(spacing: 8) {
                Text(title).font(.title2).fontWeight(.bold).multilineTextAlignment(.center)
                Text(subtitle).font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
            }
            content
            Spacer()
            Button(action: onContinue) {
                Text(buttonLabel).font(.headline).foregroundColor(.white)
                    .frame(maxWidth: .infinity).padding()
                    .background(Color.accentColor)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            }
            .padding(.bottom, 32)
        }
        .padding(.horizontal, 28)
    }
}
