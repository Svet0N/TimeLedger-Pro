const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://jfpyxtrutbwnithepezr.supabase.co', 'sb_publishable_kpU9p3-TYgxm8LF_yxJ7Pw_yi7Gn3Ok');
async function test() {
    console.log('Testing auth...');
    const { data, error } = await sb.auth.signUp({ email: `test_${Date.now()}@test.local`, password: 'password123' });
    console.log('Signup:', error ? error.message : data?.user?.id);
    if (!error && data?.session) {
        const { error: postErr } = await sb.from('user_profiles').insert({ id: data.user.id, full_name: 'Test' });
        console.log('Insert Error:', postErr ? postErr.message : 'OK');
    } else if (!error && !data.session) {
        console.log('Email confirmation required, no session.');
    }
}
test();
