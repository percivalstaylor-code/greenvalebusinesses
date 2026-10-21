// Business categories → Google Places "Table A" types.
//
// Each type is searched separately (Text Search accepts one includedType),
// which avoids leaning on one broad "businesses in Greenvale" query and its
// 60-result cap. The same type list is sent to the Places Aggregate API
// (includedTypes is an OR filter) to get Google's own list of matching place
// IDs inside the electorate polygon.
//
// `queries` are free-text searches for businesses that have no dedicated
// Table A type (e.g. builders, fabricators). Their results cannot always be
// matched to the Aggregate check, so they are more likely to need review.
//
// `serviceArea: true` asks Google to include pure service-area businesses
// (no public premises); these are listed separately and never get a marker.

export const CATEGORIES = [
  {
    id: 'retail',
    label: 'Retail',
    types: [
      ['supermarket', 'Supermarket'],
      ['grocery_store', 'Grocery store'],
      ['convenience_store', 'Convenience store'],
      ['asian_grocery_store', 'Asian grocery'],
      ['butcher_shop', 'Butcher'],
      ['liquor_store', 'Liquor store'],
      ['shopping_mall', 'Shopping centre'],
      ['department_store', 'Department store'],
      ['discount_store', 'Discount store'],
      ['clothing_store', 'Clothing store'],
      ['shoe_store', 'Shoe store'],
      ['jewelry_store', 'Jewellery store'],
      ['cosmetics_store', 'Cosmetics store'],
      ['electronics_store', 'Electronics store'],
      ['cell_phone_store', 'Mobile phone store'],
      ['furniture_store', 'Furniture store'],
      ['home_goods_store', 'Homewares'],
      ['hardware_store', 'Hardware store'],
      ['home_improvement_store', 'Home improvement'],
      ['garden_center', 'Garden centre'],
      ['pet_store', 'Pet store'],
      ['florist', 'Florist'],
      ['gift_shop', 'Gift shop'],
      ['book_store', 'Book store'],
      ['toy_store', 'Toy store'],
      ['sporting_goods_store', 'Sporting goods'],
      ['thrift_store', 'Op shop'],
      ['store', 'Other store'],
    ],
  },
  {
    id: 'hospitality',
    label: 'Hospitality',
    types: [
      ['restaurant', 'Restaurant'],
      ['cafe', 'Cafe'],
      ['coffee_shop', 'Coffee shop'],
      ['bakery', 'Bakery'],
      ['fast_food_restaurant', 'Fast food'],
      ['meal_takeaway', 'Takeaway'],
      ['pizza_restaurant', 'Pizza'],
      ['bar', 'Bar'],
      ['pub', 'Pub'],
      ['dessert_shop', 'Dessert shop'],
      ['ice_cream_shop', 'Ice cream'],
      ['food_court', 'Food court'],
      ['catering_service', 'Catering'],
      ['hotel', 'Hotel'],
      ['motel', 'Motel'],
      ['lodging', 'Other accommodation'],
    ],
  },
  {
    id: 'health',
    label: 'Health',
    types: [
      ['doctor', 'Doctor / GP'],
      ['medical_clinic', 'Medical clinic'],
      ['medical_center', 'Medical centre'],
      ['dentist', 'Dentist'],
      ['dental_clinic', 'Dental clinic'],
      ['pharmacy', 'Pharmacy'],
      ['drugstore', 'Chemist'],
      ['physiotherapist', 'Physiotherapist'],
      ['chiropractor', 'Chiropractor'],
      ['medical_lab', 'Pathology / medical lab'],
      ['hospital', 'Hospital'],
      ['wellness_center', 'Wellness centre'],
      ['veterinary_care', 'Veterinary'],
    ],
  },
  {
    id: 'beauty',
    label: 'Beauty & personal care',
    types: [
      ['hair_salon', 'Hair salon'],
      ['barber_shop', 'Barber'],
      ['beauty_salon', 'Beauty salon'],
      ['nail_salon', 'Nail salon'],
      ['beautician', 'Beautician'],
      ['spa', 'Day spa'],
      ['massage', 'Massage'],
      ['skin_care_clinic', 'Skin clinic'],
      ['makeup_artist', 'Make-up artist'],
      ['tanning_studio', 'Tanning'],
      ['body_art_service', 'Tattoo / piercing'],
    ],
  },
  {
    id: 'professional',
    label: 'Professional services',
    types: [
      ['accounting', 'Accountant'],
      ['lawyer', 'Lawyer'],
      ['insurance_agency', 'Insurance'],
      ['real_estate_agency', 'Real estate'],
      ['bank', 'Bank'],
      ['travel_agency', 'Travel agent'],
      ['employment_agency', 'Employment agency'],
      ['consultant', 'Consultant'],
      ['marketing_consultant', 'Marketing'],
      ['telecommunications_service_provider', 'Telecommunications'],
      ['corporate_office', 'Corporate office'],
      ['coworking_space', 'Coworking'],
    ],
  },
  {
    id: 'automotive',
    label: 'Automotive',
    types: [
      ['car_repair', 'Mechanic / car repair'],
      ['car_dealer', 'Car dealer'],
      ['truck_dealer', 'Truck dealer'],
      ['auto_parts_store', 'Auto parts'],
      ['tire_shop', 'Tyres'],
      ['car_wash', 'Car wash'],
      ['gas_station', 'Service station'],
      ['car_rental', 'Car hire'],
    ],
  },
  {
    id: 'trades',
    label: 'Trades',
    serviceArea: true,
    types: [
      ['electrician', 'Electrician'],
      ['plumber', 'Plumber'],
      ['roofing_contractor', 'Roofing'],
      ['painter', 'Painter'],
      ['locksmith', 'Locksmith'],
      ['moving_company', 'Removalist'],
    ],
    queries: ['builder', 'carpenter', 'landscaping', 'air conditioning installer', 'concreting contractor', 'cabinet maker'],
  },
  {
    id: 'industrial',
    label: 'Industrial & wholesale',
    types: [
      ['manufacturer', 'Manufacturer'],
      ['supplier', 'Supplier'],
      ['wholesaler', 'Wholesaler'],
      ['warehouse_store', 'Warehouse store'],
      ['building_materials_store', 'Building materials'],
      ['storage', 'Storage'],
      ['courier_service', 'Courier'],
      ['shipping_service', 'Freight / shipping'],
    ],
    queries: ['factory', 'engineering workshop', 'metal fabrication', 'logistics warehouse', 'transport company'],
  },
  {
    id: 'community',
    label: 'Other local services',
    types: [
      ['child_care_agency', 'Childcare'],
      ['preschool', 'Kindergarten / preschool'],
      ['gym', 'Gym'],
      ['fitness_center', 'Fitness centre'],
      ['laundry', 'Laundromat / dry cleaner'],
      ['tailor', 'Tailor'],
      ['pet_care', 'Pet care'],
      ['funeral_home', 'Funeral home'],
    ],
  },
].map((c) => ({
  serviceArea: false,
  queries: [],
  ...c,
  types: c.types.map(([type, label]) => ({ type, label })),
}));

export const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

/** Our category for a place, from its Google types (first category whose type list matches). */
export function categoryForTypes(types = [], primaryType = null) {
  const ordered = primaryType ? [primaryType, ...types] : types;
  for (const t of ordered) {
    for (const c of CATEGORIES) if (c.types.some((x) => x.type === t && t !== 'store' && t !== 'lodging')) return c.id;
  }
  for (const t of ordered) for (const c of CATEGORIES) if (c.types.some((x) => x.type === t)) return c.id;
  return null;
}

export function publicCategories() {
  return CATEGORIES.map(({ id, label, types, queries, serviceArea }) => ({ id, label, types, queries, serviceArea }));
}
