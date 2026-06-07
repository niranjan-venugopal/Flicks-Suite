-- =============================================================================
-- 0015 — Invoicing v3: seed data
-- =============================================================================
-- 1) hsn_sac_codes — global master of popular HSN (goods) + SAC (services)
--    codes with indicative default GST rates. Illustrative; tenants may add
--    their own. Idempotent via ON CONFLICT (code).
-- 2) tenant_module_toggles — enable Invoicing for every existing tenant
--    (PRD §10: default invoicing=enabled). Idempotent.
--
-- NOTE: GST rates here are common defaults for convenience only — the final
-- rate on an invoice is always the user-/item-selected rate.
-- =============================================================================

INSERT INTO hsn_sac_codes (code, type, description, default_gst_rate, category, popularity) VALUES
  -- ── Services (SAC, 99xxxx) ──────────────────────────────────────────────────
  ('998314', 'SAC', 'Information technology (IT) design and development services', 18, 'IT & Software', 100),
  ('998313', 'SAC', 'IT consulting and support services', 18, 'IT & Software', 98),
  ('998315', 'SAC', 'Hosting and IT infrastructure provisioning services', 18, 'IT & Software', 90),
  ('998316', 'SAC', 'IT infrastructure and network management services', 18, 'IT & Software', 80),
  ('997331', 'SAC', 'Licensing services for the right to use computer software', 18, 'IT & Software', 88),
  ('998319', 'SAC', 'Other information technology services n.e.c.', 18, 'IT & Software', 70),
  ('998311', 'SAC', 'Management consulting and management services', 18, 'Consulting', 95),
  ('998312', 'SAC', 'Business consulting services', 18, 'Consulting', 92),
  ('998399', 'SAC', 'Other professional, technical and business services n.e.c.', 18, 'Professional', 75),
  ('998221', 'SAC', 'Accounting and bookkeeping services', 18, 'Finance & Accounting', 85),
  ('998222', 'SAC', 'Auditing and financial statement review services', 18, 'Finance & Accounting', 84),
  ('998231', 'SAC', 'Corporate tax consulting and preparation services', 18, 'Finance & Accounting', 82),
  ('998232', 'SAC', 'Individual tax preparation and planning services', 18, 'Finance & Accounting', 70),
  ('998212', 'SAC', 'Legal services concerning business and commercial law', 18, 'Legal', 80),
  ('998213', 'SAC', 'Legal documentation and certification services', 18, 'Legal', 72),
  ('998361', 'SAC', 'Advertising services', 18, 'Marketing & Advertising', 86),
  ('998365', 'SAC', 'Sale of internet advertising space', 18, 'Marketing & Advertising', 78),
  ('998363', 'SAC', 'Sale of advertising space in print media', 5, 'Marketing & Advertising', 60),
  ('998341', 'SAC', 'Architectural and design services', 18, 'Design', 74),
  ('998342', 'SAC', 'Engineering and technical consulting services', 18, 'Engineering', 76),
  ('998391', 'SAC', 'Specialty design services (graphic, web, UI/UX)', 18, 'Design', 82),
  ('998596', 'SAC', 'Events, exhibitions and convention services', 18, 'Events', 64),
  ('998511', 'SAC', 'Recruitment and executive search services', 18, 'HR & Staffing', 70),
  ('998513', 'SAC', 'Contract staffing and manpower supply services', 18, 'HR & Staffing', 68),
  ('999293', 'SAC', 'Commercial training and coaching services', 18, 'Education & Training', 66),
  ('998431', 'SAC', 'Online content, software-as-a-service (subscription)', 18, 'IT & Software', 96),
  ('996511', 'SAC', 'Road transport services for goods', 5, 'Logistics & Transport', 62),
  ('996812', 'SAC', 'Courier and express delivery services', 18, 'Logistics & Transport', 60),
  ('997212', 'SAC', 'Rental or leasing services of commercial property', 18, 'Real Estate', 58),
  ('998714', 'SAC', 'Maintenance and repair of computers and peripherals', 18, 'IT & Software', 64),
  ('998722', 'SAC', 'Maintenance and repair of electrical equipment', 18, 'Maintenance', 50),
  ('997221', 'SAC', 'Property management services', 18, 'Real Estate', 48),
  ('998381', 'SAC', 'Photography and videography services', 18, 'Media', 55),
  ('998346', 'SAC', 'Technical testing and analysis services', 18, 'Engineering', 52),
  ('999511', 'SAC', 'Membership organisation and association services', 18, 'Professional', 40),
  -- ── Goods (HSN) ─────────────────────────────────────────────────────────────
  ('8471', 'HSN', 'Computers, laptops and data-processing machines', 18, 'Electronics', 90),
  ('8517', 'HSN', 'Telephones, smartphones and communication apparatus', 18, 'Electronics', 88),
  ('8523', 'HSN', 'Storage media; software on physical media', 18, 'Electronics', 70),
  ('8528', 'HSN', 'Monitors, projectors and display units', 18, 'Electronics', 72),
  ('8443', 'HSN', 'Printers, copiers and printing machinery', 18, 'Electronics', 60),
  ('8504', 'HSN', 'Power adapters, UPS and electrical transformers', 18, 'Electronics', 58),
  ('8544', 'HSN', 'Insulated wires, cables and connectors', 18, 'Electronics', 50),
  ('9403', 'HSN', 'Furniture (office, wooden and metal) and parts', 18, 'Furniture', 64),
  ('9401', 'HSN', 'Seats and chairs (office and other)', 18, 'Furniture', 62),
  ('4820', 'HSN', 'Registers, notebooks, files and paper stationery', 18, 'Stationery', 55),
  ('4901', 'HSN', 'Printed books, brochures and similar printed matter', 0, 'Publishing', 48),
  ('4911', 'HSN', 'Printed advertising material and catalogues', 12, 'Publishing', 44),
  ('4202', 'HSN', 'Bags, cases and similar containers', 18, 'Accessories', 40),
  ('6109', 'HSN', 'T-shirts, singlets and vests (knitted)', 5, 'Apparel', 52),
  ('6205', 'HSN', 'Men''s shirts', 5, 'Apparel', 46),
  ('6110', 'HSN', 'Sweaters, pullovers and similar knitted apparel', 12, 'Apparel', 45),
  ('4819', 'HSN', 'Cartons, boxes and packaging of paper', 18, 'Packaging', 42),
  ('3923', 'HSN', 'Plastic packaging articles and containers', 18, 'Packaging', 38),
  ('2106', 'HSN', 'Food preparations not elsewhere specified', 18, 'Food & Beverage', 50),
  ('2202', 'HSN', 'Waters and non-alcoholic beverages', 18, 'Food & Beverage', 48),
  ('0902', 'HSN', 'Tea', 5, 'Food & Beverage', 36),
  ('0901', 'HSN', 'Coffee', 5, 'Food & Beverage', 36),
  ('3304', 'HSN', 'Beauty and cosmetic preparations', 18, 'Personal Care', 40),
  ('3401', 'HSN', 'Soaps and organic surface-active products', 18, 'Personal Care', 34),
  ('8703', 'HSN', 'Motor cars and passenger vehicles', 28, 'Automotive', 44),
  ('8708', 'HSN', 'Parts and accessories of motor vehicles', 28, 'Automotive', 38),
  ('8714', 'HSN', 'Parts and accessories of bicycles and two-wheelers', 18, 'Automotive', 30),
  ('9018', 'HSN', 'Medical, surgical and diagnostic instruments', 12, 'Medical', 42),
  ('3004', 'HSN', 'Medicaments (packaged for retail sale)', 12, 'Pharma', 46),
  ('9404', 'HSN', 'Mattresses, cushions and bedding articles', 18, 'Furniture', 32),
  ('7308', 'HSN', 'Structures and parts of iron or steel', 18, 'Construction', 40),
  ('2523', 'HSN', 'Cement', 28, 'Construction', 44),
  ('6802', 'HSN', 'Worked stone (marble, granite) for construction', 18, 'Construction', 30),
  ('3208', 'HSN', 'Paints and varnishes', 18, 'Construction', 34),
  ('8413', 'HSN', 'Pumps for liquids', 18, 'Machinery', 28),
  ('8419', 'HSN', 'Industrial machinery for temperature treatment', 18, 'Machinery', 26),
  ('8537', 'HSN', 'Boards, panels and control equipment', 18, 'Machinery', 28),
  ('9405', 'HSN', 'Lamps, lighting fittings and LED luminaires', 18, 'Electronics', 36),
  ('8536', 'HSN', 'Electrical switches, relays and fuses', 18, 'Electronics', 34),
  ('3926', 'HSN', 'Other articles of plastics', 18, 'General', 30),
  ('7323', 'HSN', 'Household articles of iron or steel', 18, 'General', 26),
  ('4016', 'HSN', 'Articles of vulcanised rubber', 18, 'General', 24),
  ('8421', 'HSN', 'Filtering and purifying machinery (air/water)', 18, 'Machinery', 28),
  ('9031', 'HSN', 'Measuring or checking instruments', 18, 'Engineering', 30),
  ('8473', 'HSN', 'Parts and accessories of computers/office machines', 18, 'Electronics', 56),
  ('8518', 'HSN', 'Microphones, loudspeakers and audio equipment', 18, 'Electronics', 40),
  ('9504', 'HSN', 'Video game consoles and gaming articles', 28, 'Electronics', 30),
  ('4823', 'HSN', 'Other paper, cut to size, and paper articles', 18, 'Stationery', 28),
  ('3215', 'HSN', 'Printing ink, writing ink and toner', 18, 'Stationery', 26),
  ('8472', 'HSN', 'Other office machines (shredders, laminators)', 18, 'Electronics', 30)
ON CONFLICT (code) DO NOTHING;

-- ─── tenant_module_toggles: enable Invoicing for all existing tenants ───────────
INSERT INTO tenant_module_toggles (tenant_id, module, enabled)
SELECT id, 'invoicing', TRUE FROM tenants
ON CONFLICT (tenant_id, module) DO NOTHING;
