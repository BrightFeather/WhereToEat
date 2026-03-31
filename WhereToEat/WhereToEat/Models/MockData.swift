import Foundation

enum MockData {
    static let restaurants: [Restaurant] = [
        Restaurant(
            name: "Zuni Café",
            address: "1658 Market St, San Francisco, CA 94102",
            neighborhood: "Hayes Valley",
            coordinates: Coordinates(latitude: 37.7749, longitude: -122.4222),
            cuisineTags: [.american, .mediterranean],
            priceRange: 3,
            rating: 4.5,
            reviewCount: 3820,
            reviewSnippets: [
                Review(platform: .yelp, text: "The brick oven chicken for two is legendary. Worth every penny.", rating: 5),
                Review(platform: .google, text: "Classic SF institution. Caesar salad is a must-order.", rating: 4)
            ],
            hours: weekdayHours(open: "11:30", close: "22:00"),
            sourceLinks: [SourceLink(platform: .yelp, url: URL(string: "https://www.yelp.com/biz/zuni-cafe-san-francisco")!)],
            phone: "+1 (415) 552-2522",
            website: URL(string: "https://zunicafe.com"),
            notes: "Famous for the roast chicken for two (45 min wait) and house-cured anchovies."
        ),
        Restaurant(
            name: "State Bird Provisions",
            address: "1529 Fillmore St, San Francisco, CA 94115",
            neighborhood: "Fillmore",
            coordinates: Coordinates(latitude: 37.7840, longitude: -122.4326),
            cuisineTags: [.american, .japanese],
            priceRange: 3,
            rating: 4.6,
            reviewCount: 2150,
            reviewSnippets: [
                Review(platform: .yelp, text: "Dim sum style service with California cuisine. So creative and fun.", rating: 5),
                Review(platform: .google, text: "The quail (state bird) dish is phenomenal. Hard to get a reservation.", rating: 5)
            ],
            hours: weekdayHours(open: "17:30", close: "22:00"),
            sourceLinks: [SourceLink(platform: .yelp, url: URL(string: "https://www.yelp.com/biz/state-bird-provisions-san-francisco")!)],
            reservationSource: ReservationSource(platform: .resy, venueId: "state-bird-provisions-sf", directBookingURL: nil),
            phone: "+1 (415) 795-1272",
            website: URL(string: "https://statebirdsf.com"),
            notes: "Michelin-starred dim-sum style tasting. Book weeks in advance."
        ),
        Restaurant(
            name: "Nopa",
            address: "560 Divisadero St, San Francisco, CA 94117",
            neighborhood: "NoPa",
            coordinates: Coordinates(latitude: 37.7749, longitude: -122.4375),
            cuisineTags: [.american, .mediterranean],
            priceRange: 2,
            rating: 4.4,
            reviewCount: 5100,
            reviewSnippets: [
                Review(platform: .yelp, text: "Late night dining done right. Wood-fired everything is delicious.", rating: 5),
                Review(platform: .google, text: "Great cocktails and the flatbread is addictive.", rating: 4)
            ],
            hours: weekdayHours(open: "18:00", close: "01:00"),
            sourceLinks: [SourceLink(platform: .yelp, url: URL(string: "https://www.yelp.com/biz/nopa-san-francisco")!)],
            reservationSource: ReservationSource(platform: .resy, venueId: "nopa-sf", directBookingURL: nil),
            phone: "+1 (415) 864-8643",
            website: URL(string: "https://nopasf.com"),
            notes: "Open until 1am on weekends. Farm-to-table California cuisine."
        ),
        Restaurant(
            name: "Kin Khao",
            address: "55 Cyril Magnin St, San Francisco, CA 94102",
            neighborhood: "Union Square",
            coordinates: Coordinates(latitude: 37.7847, longitude: -122.4083),
            cuisineTags: [.thai],
            priceRange: 2,
            rating: 4.3,
            reviewCount: 1890,
            reviewSnippets: [
                Review(platform: .yelp, text: "Authentic Thai flavors, not dumbed down for American palates. Love it.", rating: 5),
                Review(platform: .google, text: "The boat noodles and green papaya salad are standouts.", rating: 4)
            ],
            hours: weekdayHours(open: "11:30", close: "21:30"),
            sourceLinks: [SourceLink(platform: .yelp, url: URL(string: "https://www.yelp.com/biz/kin-khao-san-francisco")!)],
            phone: "+1 (415) 362-7456",
            website: URL(string: "https://kinkhao.com"),
            notes: "Michelin Bib Gourmand. Uses organic, locally sourced ingredients."
        ),
        Restaurant(
            name: "Flour + Water",
            address: "2401 Harrison St, San Francisco, CA 94110",
            neighborhood: "Mission",
            coordinates: Coordinates(latitude: 37.7588, longitude: -122.4136),
            cuisineTags: [.italian],
            priceRange: 3,
            rating: 4.5,
            reviewCount: 3240,
            reviewSnippets: [
                Review(platform: .yelp, text: "Handmade pasta that rivals anything in Italy. The tagliatelle is perfection.", rating: 5),
                Review(platform: .google, text: "Wood-fired pizza and fresh pasta. Hard choice which to get.", rating: 5)
            ],
            hours: weekdayHours(open: "17:30", close: "22:00"),
            sourceLinks: [SourceLink(platform: .yelp, url: URL(string: "https://www.yelp.com/biz/flour-water-san-francisco")!)],
            reservationSource: ReservationSource(platform: .resy, venueId: "flour-water-sf", directBookingURL: nil),
            phone: "+1 (415) 826-7000",
            website: URL(string: "https://flourandwater.com"),
            notes: "Seasonal pasta menu changes frequently. Great natural wine list."
        ),
        Restaurant(
            name: "Lazy Bear",
            address: "3416 19th St, San Francisco, CA 94110",
            neighborhood: "Mission",
            coordinates: Coordinates(latitude: 37.7602, longitude: -122.4194),
            cuisineTags: [.american],
            priceRange: 4,
            rating: 4.7,
            reviewCount: 980,
            reviewSnippets: [
                Review(platform: .yelp, text: "One of the best dining experiences of my life. Communal tables, incredible food.", rating: 5),
                Review(platform: .google, text: "Two Michelin stars. The price is steep but absolutely worth it.", rating: 5)
            ],
            hours: [
                DayHours(day: 3, openTime: "18:00", closeTime: "22:00", isClosed: false),
                DayHours(day: 4, openTime: "18:00", closeTime: "22:00", isClosed: false),
                DayHours(day: 5, openTime: "18:00", closeTime: "22:00", isClosed: false),
                DayHours(day: 6, openTime: "18:00", closeTime: "22:00", isClosed: false)
            ],
            sourceLinks: [SourceLink(platform: .yelp, url: URL(string: "https://www.yelp.com/biz/lazy-bear-san-francisco")!)],
            reservationSource: ReservationSource(platform: .tock, venueId: "lazy-bear", directBookingURL: nil),
            phone: "+1 (415) 874-9921",
            website: URL(string: "https://lazybearsf.com"),
            notes: "Two Michelin stars. Prix-fixe tickets sold in advance via Tock."
        ),
        Restaurant(
            name: "Burma Superstar",
            address: "309 Clement St, San Francisco, CA 94118",
            neighborhood: "Inner Richmond",
            coordinates: Coordinates(latitude: 37.7827, longitude: -122.4637),
            cuisineTags: [.other],
            priceRange: 2,
            rating: 4.2,
            reviewCount: 6700,
            reviewSnippets: [
                Review(platform: .yelp, text: "The tea leaf salad is life-changing. Always a wait but worth it.", rating: 5),
                Review(platform: .google, text: "Burmese comfort food at its finest.", rating: 4)
            ],
            hours: weekdayHours(open: "11:00", close: "21:30"),
            sourceLinks: [SourceLink(platform: .yelp, url: URL(string: "https://www.yelp.com/biz/burma-superstar-san-francisco")!)],
            phone: "+1 (415) 387-2147",
            website: URL(string: "https://burmasuperstar.com"),
            notes: "No reservations, expect a wait. The rainbow salad and mohinga are must-tries."
        ),
        Restaurant(
            name: "Che Fico",
            address: "838 Divisadero St, San Francisco, CA 94117",
            neighborhood: "NoPa",
            coordinates: Coordinates(latitude: 37.7762, longitude: -122.4375),
            cuisineTags: [.italian],
            priceRange: 3,
            rating: 4.4,
            reviewCount: 1650,
            reviewSnippets: [
                Review(platform: .yelp, text: "Wood-fired Neapolitan pizza and house-cured charcuterie. SF Italian at its best.", rating: 5),
                Review(platform: .google, text: "The ricotta toast and the cacio e pepe pizza are insane.", rating: 4)
            ],
            hours: weekdayHours(open: "17:00", close: "22:00"),
            sourceLinks: [SourceLink(platform: .yelp, url: URL(string: "https://www.yelp.com/biz/che-fico-san-francisco")!)],
            reservationSource: ReservationSource(platform: .resy, venueId: "che-fico-sf", directBookingURL: nil),
            phone: "+1 (415) 416-6959",
            website: URL(string: "https://chefico.com"),
            notes: "Rustic Italian with a huge open kitchen. Great pasta and natural wines."
        )
    ]

    // Helper to generate standard Mon–Sun hours
    private static func weekdayHours(open: String, close: String) -> [DayHours] {
        (0...6).map { day in
            DayHours(day: day, openTime: open, closeTime: close, isClosed: day == 0)
        }
    }
}
