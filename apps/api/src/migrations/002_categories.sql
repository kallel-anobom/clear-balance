insert into categories (slug, name, kind) values
  ('moradia',      'Moradia',                       'expense'),
  ('saude',        'Saúde',                         'expense'),
  ('educacao',     'Educação',                      'expense'),
  ('transporte',   'Transporte',                    'expense'),
  ('servicos',     'Contas e serviços',             'expense'),
  ('mercado',      'Mercado',                       'expense'),
  ('alimentacao',  'Alimentação fora de casa',      'expense'),
  ('lazer',        'Lazer e assinaturas',           'expense'),
  ('compras',      'Compras',                       'expense'),
  ('juros-tarifas','Juros e tarifas (cheque especial)', 'expense'),
  ('outros',       'Outros',                        'expense'),
  ('salario',      'Salário',                       'income'),
  ('outras-receitas', 'Outras receitas',            'income')
on conflict (slug) do nothing;
