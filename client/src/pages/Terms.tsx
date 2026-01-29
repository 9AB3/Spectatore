import Header from '../components/Header';
import TermsContent from '../components/TermsContent';

export default function Terms() {
  return (
    <div>
      <Header />
      <div className="text-[15px] leading-relaxed max-w-[38ch] mx-auto max-w-3xl mx-auto p-4 pb-24">
        <div className="text-[15px] leading-relaxed max-w-[38ch] mx-auto card p-5">
          <TermsContent />
        </div>
      </div>
    </div>
  );
}
