import { Button, Input, Card } from '@nextui-org/react';
import { useState } from 'react';

export const AuthForm = () => {
const [formData, setFormData] = useState({
    username: '',
    password: '',
    domain: 'beeper.com',
});

const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Submit to API endpoint
};

    return (
    <Card className="p-6 max-w-md mx-auto">
        <form onSubmit={handleSubmit} className="space-y-4">
        <Input
            label="Username"
            value={formData.username}
            onChange={(e) => setFormData({ ...formData, username: e.target.value })}
        />
        <Input
            label="Password"
            type="password"
            value={formData.password}
            onChange={(e) => setFormData({ ...formData, password: e.target.value })}
        />
        <Input
            label="Domain"
            value={formData.domain}
            onChange={(e) => setFormData({ ...formData, domain: e.target.value })}
        />
        <Button type="submit" color="primary">
            Connect
        </Button>
        </form>
    </Card>
    );
};
